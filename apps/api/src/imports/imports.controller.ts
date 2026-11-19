import { Body, Controller, Get, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Auth, type AuthContext } from '../auth/auth.context';
import { RequireRole } from '../auth/require-role.decorator';
import { TenantGuard } from '../auth/tenant.guard';
import { isUuid } from '../catalog/catalog.validation';
import { ApiError, ValidationError } from '../http/api-error';
import { resolveMapping } from './column-mapping';
import { CsvError, parseCsv, type ParsedCsv } from './csv';
import { codesInFile, previewRows } from './import-preview';
import type { ImportBatch, ImportRow, ImportRowQuery } from './imports.models';
import { ImportsRepository } from './imports.repository';
import {
  CSV_LIMITS,
  DEFAULT_ROW_LIMIT,
  parseImportRowQuery,
  parseNewImport,
} from './imports.validation';

interface ImportPreview {
  data: ImportBatch & { rows: ImportRow[] };
  page: ImportRowQuery & { hasMore: boolean };
}

function notFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'not_found', 'Import not found');
}

/**
 * CSV imports of stock movements. Uploading a file stores a preview: every
 * row checked against the catalog and the movement rules, with errors per
 * row. Nothing is written to the stock ledger here.
 */
@Controller('v1/organizations/:orgId/imports')
@UseGuards(TenantGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsRepository) {}

  /**
   * `201` with the stored batch, its column mapping and the first rows.
   * A file that cannot be read, or a mapping that misses a required field,
   * is a `422` and nothing is stored. Invalid rows do not fail the upload;
   * they are listed with their errors.
   */
  @Post()
  @RequireRole('manager')
  async upload(@Auth() auth: AuthContext, @Body() body: unknown): Promise<ImportPreview> {
    const input = parseNewImport(body);
    const organizationId = auth.organizationId as string;

    let csv: ParsedCsv;
    try {
      csv = parseCsv(input.content, CSV_LIMITS);
    } catch (error) {
      if (error instanceof CsvError) {
        throw new ValidationError([{ field: 'content', message: error.message }]);
      }
      throw error;
    }
    if (csv.records.length === 0) {
      throw new ValidationError([{ field: 'content', message: 'has a header but no data rows' }]);
    }

    const { mapping, errors } = resolveMapping(csv.header, input.mapping);
    if (errors.length > 0) throw new ValidationError(errors);

    const { skuCodes, warehouseCodes } = codesInFile(csv.header, mapping, csv.records);
    const catalog = await this.imports.findCatalogCodes(organizationId, skuCodes, warehouseCodes);
    const rows = previewRows(csv.header, mapping, input.defaultType, catalog, csv.records);

    const batch = await this.imports.createBatch(organizationId, auth.userId, {
      fileName: input.fileName,
      fileSha256: createHash('sha256').update(input.content).digest('hex'),
      delimiter: csv.delimiter,
      columns: csv.header,
      mapping,
      defaultType: input.defaultType,
      rows,
    });
    const page = { status: null, limit: DEFAULT_ROW_LIMIT, offset: 0 };
    return {
      data: { ...batch, rows: rows.slice(0, page.limit) },
      page: { ...page, hasMore: rows.length > page.limit },
    };
  }

  /** The batch with a page of its rows; `?status=invalid` lists only rows to fix. */
  @Get(':importId')
  @RequireRole('viewer')
  async get(
    @Auth() auth: AuthContext,
    @Param('importId') importId: string,
    @Query() query: unknown,
  ): Promise<ImportPreview> {
    const organizationId = auth.organizationId as string;
    if (!isUuid(importId)) throw notFound();
    const page = parseImportRowQuery(query);
    const batch = await this.imports.findBatch(organizationId, importId);
    if (!batch) throw notFound();
    const { rows, hasMore } = await this.imports.listRows(organizationId, batch.id, page);
    return { data: { ...batch, rows }, page: { ...page, hasMore } };
  }
}
