import { Controller, Get } from '@nestjs/common';
import { __CONSTANT_NAME__ } from '__COMMON_IMPORT_PATH__';

@Controller(__CONSTANT_NAME__)
export class __CONTROLLER_NAME__ {
  @Get()
  getHello(): string {
    return 'Hello from __COMPANY_NAME__ Enach';
  }
}