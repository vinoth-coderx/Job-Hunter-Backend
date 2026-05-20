"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runtimeModeFromHeader = void 0;
const dbConnections_1 = require("../config/dbConnections");
const runtimeModeFromHeader = (req, res, next) => {
    const raw = req.header('x-runtime-mode');
    const mode = raw === 'test' || raw === 'live' ? raw : dbConnections_1.DEFAULT_RUNTIME_MODE;
    res.setHeader('X-Runtime-Mode', mode);
    (0, dbConnections_1.runWithMode)(mode, () => next());
};
exports.runtimeModeFromHeader = runtimeModeFromHeader;
