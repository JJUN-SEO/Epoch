ENABLE_BETA = False


def run():
    if ENABLE_BETA:  # @C
        return 1  # @E
    return 0
