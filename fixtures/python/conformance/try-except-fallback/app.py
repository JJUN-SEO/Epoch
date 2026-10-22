try:
    from fast import parse
except ImportError:
    from slow import parse
