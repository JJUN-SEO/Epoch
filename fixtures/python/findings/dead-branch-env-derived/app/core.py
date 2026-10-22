import os

ENABLED = os.environ.get("FEATURE_X") == "1"


def run():
    if ENABLED:
        return 1
    return 0
