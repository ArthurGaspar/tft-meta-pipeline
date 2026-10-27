"""What a run would cost on AWS, from published on-demand list prices.

Approximate us-east-1 prices; check the AWS pricing pages before relying on
them. The free tier is ignored here: a run this size fits inside it.
"""

LAMBDA_PER_GB_SECOND = 0.0000166667
LAMBDA_PER_MILLION_REQUESTS = 0.20
S3_PER_1000_PUT_LIST = 0.005
S3_PER_1000_GET = 0.0004
S3_PER_GB_MONTH = 0.023
RDS_T4G_MICRO_PER_HOUR = 0.016


def estimate(functions: dict, s3_requests: dict, bytes_stored: int) -> dict:
    gb_s = sum(f["gbSeconds"] for f in functions.values())
    requests = sum(f["invocations"] for f in functions.values())
    lam = gb_s * LAMBDA_PER_GB_SECOND + requests / 1e6 * LAMBDA_PER_MILLION_REQUESTS
    s3 = (s3_requests["PUT"] + s3_requests["LIST"]) / 1000 * S3_PER_1000_PUT_LIST + s3_requests["GET"] / 1000 * S3_PER_1000_GET
    storage_month = bytes_stored / 1024**3 * S3_PER_GB_MONTH
    return {
        "lambdaUsd": round(lam, 6),
        "s3RequestsUsd": round(s3, 6),
        "s3StoragePerMonthUsd": round(storage_month, 6),
        "rdsPerMonthUsd": round(RDS_T4G_MICRO_PER_HOUR * 730, 2),
        "note": "Approximate us-east-1 on-demand list prices, before the free tier.",
    }
