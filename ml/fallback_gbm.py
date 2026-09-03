"""Dependency-free gradient boosting, used when XGBoost is unavailable.

Why this exists
---------------
The project must train and serve a real model on a judge's laptop, and
`pip install xgboost` is the single most likely step to fail there - no wheel
for the platform, no compiler, a corporate proxy, an offline hall. Rather than
degrade to "no ML today", `train_model.py` falls back to this implementation,
which needs nothing but NumPy.

It is not a toy re-implementation of a different algorithm: it is the same
second-order (Newton) boosting XGBoost performs, with the same objective and
the same split criterion, on histogram-binned features:

    per node   G = sum g_i,  H = sum h_i          (g, h = logloss grad/hess)
    leaf value w* = -G / (H + lambda)
    split gain  = G_L^2/(H_L+lambda) + G_R^2/(H_R+lambda) - G^2/(H+lambda)

Because the trees are ordinary decision trees held in flat arrays, the same
path-attribution used for explanations works identically whichever backend
produced the model.
"""
from __future__ import annotations

import numpy as np

MAX_BINS = 64
MIN_HESSIAN = 1e-12


class Tree:
    """A single regression tree stored as flat arrays.

    `value` is filled for every node, not just leaves: an internal node holds
    the prediction it *would* make if the tree stopped there, which is what
    makes the path attribution in `contributions` possible.
    """

    __slots__ = ("feature", "threshold", "left", "right", "value", "cover")

    def __init__(self, capacity: int) -> None:
        self.feature = np.full(capacity, -1, dtype=np.int32)
        self.threshold = np.zeros(capacity, dtype=np.float64)
        self.left = np.full(capacity, -1, dtype=np.int32)
        self.right = np.full(capacity, -1, dtype=np.int32)
        self.value = np.zeros(capacity, dtype=np.float64)
        self.cover = np.zeros(capacity, dtype=np.float64)

    def trim(self, size: int) -> "Tree":
        for name in self.__slots__:
            setattr(self, name, getattr(self, name)[:size].copy())
        return self

    @property
    def size(self) -> int:
        return int(self.feature.size)

    def apply(self, X: np.ndarray) -> np.ndarray:
        """Leaf index reached by every row."""
        node = np.zeros(X.shape[0], dtype=np.int32)
        active = self.feature[node] >= 0
        while np.any(active):
            idx = np.flatnonzero(active)
            f = self.feature[node[idx]]
            go_left = X[idx, f] <= self.threshold[node[idx]]
            node[idx] = np.where(go_left, self.left[node[idx]], self.right[node[idx]])
            active = np.zeros(X.shape[0], dtype=bool)
            active[idx] = self.feature[node[idx]] >= 0
        return node

    def predict(self, X: np.ndarray) -> np.ndarray:
        return self.value[self.apply(X)]

    def contributions(self, x: np.ndarray, out: np.ndarray) -> float:
        """Accumulate per-feature path attribution for one row into `out`.

        Walking root to leaf, every step is caused by exactly one feature, so
        the change in node value it produces is charged to that feature. The
        parts therefore sum exactly to (leaf value - root value).
        """
        node = 0
        while self.feature[node] >= 0:
            f = int(self.feature[node])
            child = self.left[node] if x[f] <= self.threshold[node] else self.right[node]
            out[f] += self.value[child] - self.value[node]
            node = int(child)
        return float(self.value[0])

    def split_gain_by_feature(self, n_features: int) -> np.ndarray:
        """Total cover-weighted usage per feature, for a gain-style importance."""
        totals = np.zeros(n_features, dtype=float)
        internal = np.flatnonzero(self.feature >= 0)
        for node in internal:
            totals[self.feature[node]] += self.cover[node]
        return totals


def bin_edges(X: np.ndarray, max_bins: int = MAX_BINS) -> list[np.ndarray]:
    """Quantile bin edges per feature.

    Quantiles rather than equal width, because rainfall is heavily skewed: with
    equal-width bins nearly every row lands in the first bin and the tree can
    only ever split "some rain vs a cloudburst".
    """
    edges: list[np.ndarray] = []
    for i in range(X.shape[1]):
        column = X[:, i]
        quantiles = np.linspace(0.0, 1.0, max_bins + 1)[1:-1]
        candidate = np.unique(np.quantile(column, quantiles))
        if candidate.size == 0:
            candidate = np.array([column.min()], dtype=float)
        edges.append(candidate.astype(np.float64))
    return edges


def bin_matrix(X: np.ndarray, edges: list[np.ndarray]) -> np.ndarray:
    """Map raw features onto small integer bin codes."""
    codes = np.empty(X.shape, dtype=np.int16)
    for i, cuts in enumerate(edges):
        codes[:, i] = np.searchsorted(cuts, X[:, i], side="left")
    return codes


def _best_split(
    codes: np.ndarray,
    rows: np.ndarray,
    g: np.ndarray,
    h: np.ndarray,
    edges: list[np.ndarray],
    features: np.ndarray,
    *,
    lam: float,
    min_child_weight: float,
) -> tuple[float, int, int] | None:
    """Highest-gain (feature, bin) split for one node, or None if none is legal."""
    total_g = float(g[rows].sum())
    total_h = float(h[rows].sum())
    parent = total_g * total_g / (total_h + lam)
    best: tuple[float, int, int] | None = None

    g_rows = g[rows]
    h_rows = h[rows]
    for f in features:
        n_bins = int(edges[f].size) + 1
        column = codes[rows, f]
        hist_g = np.bincount(column, weights=g_rows, minlength=n_bins)
        hist_h = np.bincount(column, weights=h_rows, minlength=n_bins)
        left_g = np.cumsum(hist_g)[:-1]
        left_h = np.cumsum(hist_h)[:-1]
        right_g = total_g - left_g
        right_h = total_h - left_h

        legal = (left_h >= min_child_weight) & (right_h >= min_child_weight)
        if not legal.any():
            continue
        gain = (
            left_g * left_g / (left_h + lam)
            + right_g * right_g / (right_h + lam)
            - parent
        )
        gain[~legal] = -np.inf
        b = int(np.argmax(gain))
        if best is None or gain[b] > best[0]:
            best = (float(gain[b]), int(f), b)
    return best


def _grow_tree(
    codes: np.ndarray,
    g: np.ndarray,
    h: np.ndarray,
    edges: list[np.ndarray],
    rng: np.random.Generator,
    *,
    max_depth: int,
    min_child_weight: float,
    lam: float,
    gamma: float,
    colsample: float,
    learning_rate: float,
) -> Tree:
    n_features = codes.shape[1]
    n_sampled = max(1, int(round(colsample * n_features)))
    tree = Tree(2 ** (max_depth + 2))
    size = 1
    queue: list[tuple[int, np.ndarray, int]] = [(0, np.arange(codes.shape[0]), 0)]

    while queue:
        node, rows, depth = queue.pop()
        node_g = float(g[rows].sum())
        node_h = float(h[rows].sum())
        tree.cover[node] = node_h
        tree.value[node] = -node_g / (node_h + lam) * learning_rate

        if depth >= max_depth or rows.size < 2 or node_h < 2.0 * min_child_weight:
            continue
        features = (
            np.arange(n_features)
            if n_sampled >= n_features
            else rng.choice(n_features, size=n_sampled, replace=False)
        )
        found = _best_split(
            codes, rows, g, h, edges, features, lam=lam, min_child_weight=min_child_weight
        )
        if found is None or found[0] <= gamma:
            continue

        _, feature, bin_index = found
        mask = codes[rows, feature] <= bin_index
        left_rows, right_rows = rows[mask], rows[~mask]
        if left_rows.size == 0 or right_rows.size == 0:
            continue

        left, right = size, size + 1
        size += 2
        tree.feature[node] = feature
        tree.threshold[node] = float(edges[feature][bin_index])
        tree.left[node] = left
        tree.right[node] = right
        queue.append((left, left_rows, depth + 1))
        queue.append((right, right_rows, depth + 1))

    return tree.trim(size)


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35.0, 35.0)))


class NumpyGBM:
    """Binary-logistic gradient boosting with a scikit-learn-shaped surface.

    Deliberately exposes `fit`, `predict_proba` and `feature_importances_` so
    that `train_model.py` and `predict.py` treat it, XGBoost and scikit-learn
    interchangeably and no backend gets special-cased downstream.
    """

    def __init__(
        self,
        *,
        n_estimators: int = 220,
        learning_rate: float = 0.09,
        max_depth: int = 5,
        min_child_weight: float = 6.0,
        reg_lambda: float = 1.2,
        gamma: float = 0.0,
        subsample: float = 0.85,
        colsample_bytree: float = 0.9,
        max_bins: int = MAX_BINS,
        random_state: int = 20260902,
    ) -> None:
        self.n_estimators = int(n_estimators)
        self.learning_rate = float(learning_rate)
        self.max_depth = int(max_depth)
        self.min_child_weight = float(min_child_weight)
        self.reg_lambda = float(reg_lambda)
        self.gamma = float(gamma)
        self.subsample = float(subsample)
        self.colsample_bytree = float(colsample_bytree)
        self.max_bins = int(max_bins)
        self.random_state = int(random_state)

        self.trees: list[Tree] = []
        self.edges: list[np.ndarray] = []
        self.base_margin: float = 0.0
        self.n_features_: int = 0

    # ------------------------------------------------------------------ fit
    def fit(self, X: np.ndarray, y: np.ndarray, sample_weight: np.ndarray | None = None) -> "NumpyGBM":
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float).ravel()
        if X.shape[0] != y.size:
            raise ValueError("X and y have different lengths")
        weight = (
            np.ones(y.size)
            if sample_weight is None
            else np.asarray(sample_weight, dtype=float).ravel()
        )

        self.n_features_ = X.shape[1]
        self.edges = bin_edges(X, self.max_bins)
        codes = bin_matrix(X, self.edges)

        prior = float(np.clip(np.average(y, weights=weight), 1e-6, 1 - 1e-6))
        self.base_margin = float(np.log(prior / (1.0 - prior)))
        margin = np.full(y.size, self.base_margin, dtype=float)

        rng = np.random.default_rng(self.random_state)
        n_sub = max(16, int(round(self.subsample * y.size)))
        self.trees = []

        for _ in range(self.n_estimators):
            p = _sigmoid(margin)
            g = weight * (p - y)
            h = weight * np.maximum(p * (1.0 - p), MIN_HESSIAN)

            if n_sub < y.size:
                rows = rng.choice(y.size, size=n_sub, replace=False)
                tree = _grow_tree(
                    codes[rows], g[rows], h[rows], self.edges, rng,
                    max_depth=self.max_depth,
                    min_child_weight=self.min_child_weight,
                    lam=self.reg_lambda,
                    gamma=self.gamma,
                    colsample=self.colsample_bytree,
                    learning_rate=self.learning_rate,
                )
            else:
                tree = _grow_tree(
                    codes, g, h, self.edges, rng,
                    max_depth=self.max_depth,
                    min_child_weight=self.min_child_weight,
                    lam=self.reg_lambda,
                    gamma=self.gamma,
                    colsample=self.colsample_bytree,
                    learning_rate=self.learning_rate,
                )
            self.trees.append(tree)
            margin += tree.predict(X)
        return self

    # -------------------------------------------------------------- predict
    def predict_margin(self, X: np.ndarray) -> np.ndarray:
        X = np.atleast_2d(np.asarray(X, dtype=float))
        margin = np.full(X.shape[0], self.base_margin, dtype=float)
        for tree in self.trees:
            margin += tree.predict(X)
        return margin

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        p = _sigmoid(self.predict_margin(X))
        return np.column_stack([1.0 - p, p])

    def predict(self, X: np.ndarray) -> np.ndarray:
        return (self.predict_proba(X)[:, 1] >= 0.5).astype(int)

    # ---------------------------------------------------------- explanation
    def contributions(self, x: np.ndarray) -> tuple[np.ndarray, float]:
        """Per-feature margin attribution for one row, plus the baseline.

        `contributions.sum() + baseline == predict_margin(x)` exactly, which is
        the additivity property the explanation panel relies on.
        """
        x = np.asarray(x, dtype=float).ravel()
        out = np.zeros(self.n_features_, dtype=float)
        baseline = self.base_margin
        for tree in self.trees:
            baseline += tree.contributions(x, out)
        return out, float(baseline)

    @property
    def feature_importances_(self) -> np.ndarray:
        totals = np.zeros(self.n_features_, dtype=float)
        for tree in self.trees:
            totals += tree.split_gain_by_feature(self.n_features_)
        total = totals.sum()
        return totals / total if total > 0 else totals

    # ------------------------------------------------------------- transport
    HYPERPARAMS = (
        "n_estimators", "learning_rate", "max_depth", "min_child_weight",
        "reg_lambda", "gamma", "subsample", "colsample_bytree", "max_bins",
        "random_state",
    )

    def to_dict(self) -> dict:
        """Plain-data form, so a saved model does not depend on this class.

        Pickling the object itself would work, but it would tie every saved
        `model.pkl` to this module's exact layout; a dict of arrays can still be
        loaded after a refactor.
        """
        return {
            "format": "numpy-gbm/1",
            "params": {name: getattr(self, name) for name in self.HYPERPARAMS},
            "base_margin": self.base_margin,
            "n_features": self.n_features_,
            "edges": [e.tolist() for e in self.edges],
            "trees": [
                {
                    "feature": t.feature.tolist(),
                    "threshold": t.threshold.tolist(),
                    "left": t.left.tolist(),
                    "right": t.right.tolist(),
                    "value": t.value.tolist(),
                    "cover": t.cover.tolist(),
                }
                for t in self.trees
            ],
        }

    @classmethod
    def from_dict(cls, blob: dict) -> "NumpyGBM":
        model = cls(**blob["params"])
        model.base_margin = float(blob["base_margin"])
        model.n_features_ = int(blob["n_features"])
        model.edges = [np.asarray(e, dtype=float) for e in blob["edges"]]
        model.trees = []
        for raw in blob["trees"]:
            tree = Tree(len(raw["feature"]))
            tree.feature = np.asarray(raw["feature"], dtype=np.int32)
            tree.threshold = np.asarray(raw["threshold"], dtype=np.float64)
            tree.left = np.asarray(raw["left"], dtype=np.int32)
            tree.right = np.asarray(raw["right"], dtype=np.int32)
            tree.value = np.asarray(raw["value"], dtype=np.float64)
            tree.cover = np.asarray(raw["cover"], dtype=np.float64)
            model.trees.append(tree)
        return model
