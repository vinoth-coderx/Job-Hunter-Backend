"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mongoose = exports.registeredModelNames = exports.bindAllRegisteredModels = void 0;
exports.multiConnModel = multiConnModel;
const mongoose_1 = __importDefault(require("mongoose"));
exports.mongoose = mongoose_1.default;
const dbConnections_1 = require("../config/dbConnections");
const registry = [];
function multiConnModel(name, schema) {
    if (!registry.some((r) => r.name === name)) {
        registry.push({ name, schema: schema });
    }
    const resolveModel = () => {
        const conn = (0, dbConnections_1.getActiveConnection)();
        const cached = conn.models[name];
        if (cached)
            return cached;
        return conn.model(name, schema);
    };
    const handler = {
        get(_target, prop) {
            const m = resolveModel();
            const value = Reflect.get(m, prop, m);
            if (typeof value === 'function')
                return value.bind(m);
            return value;
        },
        set(_target, prop, value) {
            const m = resolveModel();
            return Reflect.set(m, prop, value);
        },
        has(_target, prop) {
            const m = resolveModel();
            return Reflect.has(m, prop);
        },
        construct(_target, args) {
            const m = resolveModel();
            return Reflect.construct(m, args);
        },
    };
    const placeholder = function () { };
    return new Proxy(placeholder, handler);
}
const bindAllRegisteredModels = () => {
    for (const mode of ['test', 'live']) {
        const conn = (0, dbConnections_1.getConnectionForMode)(mode);
        for (const { name, schema } of registry) {
            if (!conn.models[name]) {
                conn.model(name, schema);
            }
        }
    }
};
exports.bindAllRegisteredModels = bindAllRegisteredModels;
const registeredModelNames = () => registry.map((r) => r.name);
exports.registeredModelNames = registeredModelNames;
