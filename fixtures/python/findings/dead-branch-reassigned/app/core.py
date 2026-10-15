_ENABLED = False


def enable():
    global _ENABLED
    _ENABLED = True


def run():
    if _ENABLED:
        return 1
    return 0
