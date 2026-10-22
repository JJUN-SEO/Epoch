import importlib
importlib.import_module("plugins.alpha")
__import__("plugins.beta")
importlib.import_module(name)
importlib.import_module(f"plugins.{name}")
