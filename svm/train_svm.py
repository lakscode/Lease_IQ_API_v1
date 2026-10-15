"""Train the lease clause classifier (TF-IDF + linear SVM) and export it for the TypeScript API.

Usage (from API/):  python svm/train_svm.py
Needs: pandas, openpyxl, scikit-learn, numpy.

Inputs
  svm/training_data/*.xlsx   column A = clause text, column B = clause id ("__label__<id>" or bare "<id>")
  svm/lease_clauses.json     {clause id: clause name}; rows whose id is not listed here are skipped

Outputs
  supabase/functions/api/lib/clause-svm-model.json   model used by lib/clause-svm.ts (Node + Edge)
  svm/training_report.json                           cross-validated metrics, per-clause scores, skipped labels

The tokenizer and TF-IDF steps here are mirrored exactly in lib/clause-svm.ts; change both together
(and bump MODEL_FORMAT) or predictions will drift.
"""
from __future__ import annotations

import glob
import json
import math
import os
import re
import warnings
from collections import Counter
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import accuracy_score, classification_report, f1_score
from sklearn.model_selection import StratifiedKFold
from sklearn.svm import LinearSVC

warnings.filterwarnings("ignore", category=UserWarning)

MODEL_FORMAT = 1
HERE = os.path.dirname(os.path.abspath(__file__))
API_DIR = os.path.dirname(HERE)
DATA_GLOB = os.path.join(HERE, "training_data", "*.xlsx")
CLAUSE_MAP = os.path.join(HERE, "lease_clauses.json")
MODEL_OUT = os.path.join(API_DIR, "supabase", "functions", "api", "lib", "clause-svm-model.json")
REPORT_OUT = os.path.join(HERE, "training_report.json")

NGRAM_RANGE = (1, 2)
MIN_DF = 2
MAX_FEATURES = 15000
SVM_C = 1.0
PRUNE_BELOW = 0.02   # |weight| below this is dropped from the export (no measurable accuracy loss)
CV_FOLDS = 5
SEED = 0

TOKEN_RE = re.compile(r"[a-z]{2,}")


def tokenize(text: str) -> list[str]:
    """Lower-case ASCII words of 2+ letters. Digits, punctuation and mojibake are separators."""
    return TOKEN_RE.findall(text.lower())


def load_rows(clause_map: dict[str, str]) -> tuple[list[str], list[str], Counter, Counter]:
    texts: list[str] = []
    labels: list[str] = []
    skipped: Counter = Counter()
    per_file: Counter = Counter()
    seen: set[tuple[str, str]] = set()
    for path in sorted(glob.glob(DATA_GLOB)):
        name = os.path.basename(path)
        for sheet in pd.read_excel(path, sheet_name=None, header=None).values():
            if sheet.shape[1] < 2:
                continue
            for text, label in sheet.iloc[:, :2].itertuples(index=False):
                if not isinstance(text, str) or not isinstance(label, str):
                    continue
                label = label.strip().removeprefix("__label__").strip()
                if label == "label":  # header row
                    continue
                if label not in clause_map:
                    skipped[label] += 1
                    continue
                norm = " ".join(tokenize(text))
                if len(norm.split()) < 2 or (norm, label) in seen:
                    continue
                seen.add((norm, label))
                texts.append(text.strip())
                labels.append(label)
                per_file[name] += 1
    return texts, labels, skipped, per_file


def make_vectorizer() -> TfidfVectorizer:
    return TfidfVectorizer(
        tokenizer=tokenize, lowercase=False, token_pattern=None, ngram_range=NGRAM_RANGE,
        min_df=MIN_DF, max_features=MAX_FEATURES, sublinear_tf=True, smooth_idf=True, norm="l2",
    )


def fit(texts, labels):
    vec = make_vectorizer()
    X = vec.fit_transform(texts)
    svm = LinearSVC(C=SVM_C, class_weight="balanced", random_state=SEED).fit(X, labels)
    W = svm.coef_.copy()
    W[np.abs(W) < PRUNE_BELOW] = 0.0
    return vec, svm, W


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def main() -> None:
    with open(CLAUSE_MAP, encoding="utf-8") as fh:
        clause_map: dict[str, str] = json.load(fh)
    texts, labels, skipped, per_file = load_rows(clause_map)
    y = np.array(labels)
    X_text = np.array(texts, dtype=object)
    counts = Counter(labels)
    print(f"{len(texts)} unique examples, {len(counts)} clause types "
          f"({sum(skipped.values())} rows skipped: {len(skipped)} ids not in lease_clauses.json)")

    # Cross-validated predictions (only for classes with enough examples to stratify).
    cv_mask = np.array([counts[l] >= CV_FOLDS for l in labels])
    cv = StratifiedKFold(CV_FOLDS, shuffle=True, random_state=SEED)
    Xc, yc = X_text[cv_mask], y[cv_mask]
    pred = np.empty(len(yc), dtype=object)
    true_scores, all_scores, test_idx = [], [], []
    for tr, te in cv.split(Xc, yc):
        vec, svm, W = fit(Xc[tr], yc[tr])
        S = vec.transform(Xc[te]) @ W.T + svm.intercept_
        pred[te] = svm.classes_[S.argmax(1)]
        idx = {c: i for i, c in enumerate(svm.classes_)}
        all_scores.append(S)
        test_idx.append(te)
        true_scores.append(np.array([idx[l] for l in yc[te]]))

    # Fit a softmax temperature on the held-out scores so `confidence` behaves like a probability.
    def nll(t: float) -> float:
        return -sum(np.log(softmax(S * t)[np.arange(len(k)), k] + 1e-12).sum() for S, k in zip(all_scores, true_scores))
    temperature = float(minimize_scalar(nll, bounds=(0.1, 50), method="bounded").x)

    conf = np.empty(len(yc))
    for S, te in zip(all_scores, test_idx):
        conf[te] = softmax(S * temperature).max(1)
    correct = pred == yc
    calibration = []
    for lo in (0.0, 0.3, 0.5, 0.7, 0.9):
        m = conf >= lo
        calibration.append({"min_confidence": lo, "coverage": round(float(m.mean()), 4),
                            "accuracy": round(float(correct[m].mean()), 4) if m.any() else None})

    acc = accuracy_score(yc, pred)
    macro = f1_score(yc, pred, average="macro")
    print(f"{CV_FOLDS}-fold CV on {len(yc)} examples: accuracy {acc:.3f}, macro F1 {macro:.3f}, temperature {temperature:.2f}")
    for row in calibration:
        print(f"  confidence >= {row['min_confidence']:.1f}: coverage {row['coverage']:.1%}, accuracy {row['accuracy']:.1%}")
    per_class = classification_report(yc, pred, output_dict=True, zero_division=0)

    # Final model on all data.
    vec, svm, W = fit(X_text, y)
    vocab = sorted(vec.vocabulary_.items(), key=lambda kv: kv[1])
    terms = [t for t, _ in vocab]
    idf = [round(float(v), 5) for v in vec.idf_]
    weights: list[list[float]] = []   # per term: flat [classIndex, weight, classIndex, weight, ...]
    for j in range(len(terms)):
        nz = np.nonzero(W[:, j])[0]
        weights.append([x for c in nz for x in (int(c), round(float(W[c, j]), 4))])
    classes = [str(c) for c in svm.classes_]

    model = {
        "format": MODEL_FORMAT,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tokenizer": {"pattern": TOKEN_RE.pattern, "lowercase": True, "ngram_range": list(NGRAM_RANGE)},
        "tfidf": {"sublinear_tf": True, "norm": "l2"},
        "temperature": round(temperature, 4),
        "classes": [{"id": c, "name": clause_map[c], "examples": counts[c]} for c in classes],
        "intercept": [round(float(b), 5) for b in svm.intercept_],
        "terms": terms,
        "idf": idf,
        "weights": weights,
    }
    os.makedirs(os.path.dirname(MODEL_OUT), exist_ok=True)
    with open(MODEL_OUT, "w", encoding="utf-8") as fh:
        json.dump(model, fh, separators=(",", ":"))

    # A few reference predictions so the TypeScript port can be checked for parity.
    sample_idx = np.random.default_rng(SEED).choice(len(X_text), size=25, replace=False)
    S = vec.transform(X_text[sample_idx]) @ W.T + svm.intercept_
    P = softmax(S * temperature)
    parity = [{"text": X_text[i], "id": classes[int(S[k].argmax())], "confidence": round(float(P[k].max()), 4)}
              for k, i in enumerate(sample_idx)]

    untrained = {cid: name for cid, name in clause_map.items() if cid not in counts}
    report = {
        "trained_at": model["trained_at"],
        "examples": len(texts),
        "clause_types": len(classes),
        "config": {"ngram_range": list(NGRAM_RANGE), "min_df": MIN_DF, "max_features": MAX_FEATURES,
                   "C": SVM_C, "class_weight": "balanced", "prune_below": PRUNE_BELOW},
        "model_nonzero_weights": int((W != 0).sum()),
        "cross_validation": {
            "folds": CV_FOLDS, "examples": int(len(yc)), "accuracy": round(acc, 4), "macro_f1": round(macro, 4),
            "excluded_small_classes": sorted({clause_map[l] for l in labels if counts[l] < CV_FOLDS}),
            "calibration": calibration,
        },
        "per_clause": sorted(
            [{"id": c, "name": clause_map[c], "examples": counts[c],
              **({k: round(per_class[c][k], 3) for k in ("precision", "recall", "f1-score")} if c in per_class else {})}
             for c in classes],
            key=lambda r: r.get("f1-score", -1)),
        "clauses_without_training_data": untrained,
        "skipped_labels_not_in_lease_clauses_json": dict(skipped.most_common()),
        "examples_per_file": dict(sorted(per_file.items())),
        "parity_samples": parity,
    }
    with open(REPORT_OUT, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    size_kb = os.path.getsize(MODEL_OUT) / 1024
    print(f"model: {len(terms)} terms, {report['model_nonzero_weights']} weights, {size_kb:,.0f} KB -> {MODEL_OUT}")
    print(f"report -> {REPORT_OUT}")
    if untrained:
        print(f"{len(untrained)} clause types in lease_clauses.json have no training data: {', '.join(untrained.values())}")


if __name__ == "__main__":
    main()
