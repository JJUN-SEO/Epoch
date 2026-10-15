_ENABLED = False


def run():
    if _ENABLED:  # @C
        return 1  # @E
    return 0
