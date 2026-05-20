"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const multiConnModel_1 = require("../utils/multiConnModel");
const originalModel = mongoose_1.default.model.bind(mongoose_1.default);
mongoose_1.default.model = function patchedModel(name, schema) {
    if (schema)
        return (0, multiConnModel_1.multiConnModel)(name, schema);
    return originalModel(name);
};
