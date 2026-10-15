from openfeature import api

client = api.get_client()


def run():
    if client.get_boolean_value("new-checkout", False):  # @C
        return 1
    return 0
