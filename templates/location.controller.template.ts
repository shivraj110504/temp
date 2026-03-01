import { Controller, Get } from '@nestjs/common';
import { __CONSTANT_NAME__ } from '__COMMON_IMPORT_PATH__';

@Controller(__CONSTANT_NAME__)
export class __CONTROLLER_NAME__ {
  @Get()
  getLocation(): string {
    return 'Location from __COMPANY_NAME__';
  }
}