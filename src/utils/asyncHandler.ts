import { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncFn<TReq extends Request = Request> = (
  req: TReq,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export const asyncHandler =
  <TReq extends Request = Request>(fn: AsyncFn<TReq>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req as TReq, res, next)).catch(next);
  };
