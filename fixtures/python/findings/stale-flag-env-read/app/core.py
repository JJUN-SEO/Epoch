import os


def run():
    return os.getenv("FEATURE_DARK_MODE") == "1"  # @C
