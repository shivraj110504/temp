import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class __MIDDLEWARE_NAME__ implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    console.log('__COMPANY_NAME__ Middleware executing...');
    next();
  }
}