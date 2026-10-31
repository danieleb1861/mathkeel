"""Independent specification of the documented interval, written from the README."""

import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path.cwd()))
from stats import mean_interval, newey_west_variance  # noqa: E402

series = [0.3, -0.2, 0.5, 0.1, -0.4, 0.6, 0.2, -0.1, 0.4, 0.0]
low, high = mean_interval(series, 2)
want = 1.96 * math.sqrt(newey_west_variance(series, 2))
if abs((high - low) / 2 - want) > 1e-12:
    print(json.dumps({"msg": f"half-width {(high - low) / 2:.6g}, documented {want:.6g}"}))
    sys.exit(1)
