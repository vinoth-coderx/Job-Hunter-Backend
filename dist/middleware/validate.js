"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validate = void 0;
const zod_1 = require("zod");
const validate = (schema) => (req, _res, next) => {
    try {
        const parsed = schema.parse({
            body: req.body,
            query: req.query,
            params: req.params,
        });
        req.body = parsed.body ?? req.body;
        req.query = parsed.query ?? req.query;
        req.params = parsed.params ?? req.params;
        next();
    }
    catch (err) {
        if (err instanceof zod_1.ZodError) {
            next(err);
            return;
        }
        next(err);
    }
};
exports.validate = validate;
