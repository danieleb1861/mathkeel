"""Independent specification of the documented variance, written from the README."""

import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path.cwd()))
from stats import newey_west_variance  # noqa: E402


def specified(values, lags):
    n = len(values)
    mean = sum(values) / n
    d = [v - mean for v in values]
    gamma = [sum(d[t] * d[t - k] for t in range(k, n)) / n for k in range(lags + 1)]
    long_run = gamma[0] + 2 * sum((1 - k / (lags + 1)) * gamma[k] for k in range(1, lags + 1))
    return long_run / n


rng = random.Random(7)
for case in range(50):
    series = [rng.gauss(0, 1) for _ in range(rng.randint(30, 80))]
    lags = rng.randint(0, 8)
    got, want = newey_west_variance(series, lags), specified(series, lags)
    if abs(got - want) > 1e-9 * max(abs(want), 1):
        print(json.dumps({"msg": f"case {case}: got {got:.6g}, documented {want:.6g}"}))
        sys.exit(1)
