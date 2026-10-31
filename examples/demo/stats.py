"""Interval for the mean of an autocorrelated series."""

import math


def newey_west_variance(values, lags):
    """Return the Newey-West variance of the sample mean."""
    n = len(values)
    mean = sum(values) / n
    centred = [value - mean for value in values]
    variance = sum(value * value for value in centred) / n
    for k in range(1, lags + 1):
        weight = 1.0 - k / (lags + 1.0)
        product = sum(centred[i] * centred[i - k] for i in range(k, n))
        variance += 2.0 * weight * product / n
    return variance / n


def mean_interval(values, lags):
    """Return the 95 percent interval for the sample mean."""
    mean = sum(values) / len(values)
    half_width = 1.96 * math.sqrt(newey_west_variance(values, lags))
    return mean - half_width, mean + half_width
