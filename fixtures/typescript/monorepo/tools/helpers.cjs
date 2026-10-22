const path = require("node:path");
exports.helper = (fs) => path.join(fs ? "a" : "b");
