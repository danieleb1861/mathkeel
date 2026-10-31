# Interval for an autocorrelated mean

A synthetic example for mathkeel. Every number here is invented.

## Assumption

The series is weakly stationary, so its autocovariances depend only on the lag.

## Variance of the mean

The long-run variance uses the Newey-West estimator with Bartlett weights.

$$\hat\sigma^2 = \hat\gamma_0 + 2\sum_{k=1}^{q}\left(1-\frac{k}{q+1}\right)\hat\gamma_k$$

Each autocovariance is divided by the full sample size n. The variance of the
mean is the long-run variance divided by n.

## Interval

The interval half-width is 1.96 times the standard error of the mean.
