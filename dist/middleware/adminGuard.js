"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdmin = void 0;
const User_1 = require("../models/User");
const ApiError_1 = require("../utils/ApiError");
const requireAdmin = async (req, _res, next) => {
    try {
        if (!req.user?.id) {
            throw ApiError_1.ApiError.unauthorized('Authentication required');
        }
        const me = await User_1.User.findById(req.user.id).select('isAdmin isBanned').lean();
        if (!me)
            throw ApiError_1.ApiError.unauthorized('User not found');
        if (me.isBanned)
            throw ApiError_1.ApiError.forbidden('Account suspended');
        if (!me.isAdmin)
            throw ApiError_1.ApiError.forbidden('Admin access required');
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.requireAdmin = requireAdmin;
