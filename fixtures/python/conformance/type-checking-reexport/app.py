from typing import TYPE_CHECKING

from pkg import run

if TYPE_CHECKING:
    from pkg import Model


def main(model: "Model"):
    return run()
