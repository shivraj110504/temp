const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─── CONFIGURE THIS PATH ────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '../project-api');
const SRC_PATH = path.join(PROJECT_ROOT, 'src');
// ─────────────────────────────────────────────────────────────────────────────

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const toPascalCase = (s) => s.split('_').map(capitalize).join('');
const toConstantCase = (s) => s.toUpperCase();

// ─── HELPER: ensure directory exists ─────────────────────────────────────────
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ─── HELPER: safe read file ───────────────────────────────────────────────────
// Handles UTF-16 LE/BE and UTF-8 BOM (all common Windows/VS Code encodings).
// Always returns a clean UTF-8 string with Unix line endings (\n) so that
// string.replace() on markers works reliably regardless of how the file was saved.
function readFile(filePath) {
    if (!fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath);

    let text;
    // UTF-16 LE BOM: FF FE
    if (raw[0] === 0xFF && raw[1] === 0xFE) {
        text = raw.toString('utf16le');
    }
    // UTF-16 BE BOM: FE FF
    else if (raw[0] === 0xFE && raw[1] === 0xFF) {
        const swapped = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length - 1; i += 2) { swapped[i] = raw[i+1]; swapped[i+1] = raw[i]; }
        text = swapped.toString('utf16le');
    }
    // UTF-8 BOM: EF BB BF
    else if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
        text = raw.slice(3).toString('utf8');
    }
    else {
        text = raw.toString('utf8');
    }

    // Strip BOM character if present, then normalise CRLF → LF
    return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ─── HELPER: always write UTF-8 without BOM, Unix line endings ───────────────
function writeFile(filePath, content) {
    // Normalise to LF before writing so the file stays consistent
    const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    fs.writeFileSync(filePath, normalised, { encoding: 'utf8' });
}

// ─── 1. Add constant to common.ts ────────────────────────────────────────────
function addConstant(normalizedName, constantName) {
    const commonTsPath = path.join(SRC_PATH, 'constant', 'common.ts');
    ensureDir(path.dirname(commonTsPath));

    // Always read with encoding-safe helper, then rewrite as clean UTF-8
    let content = readFile(commonTsPath);
    const newLine = `export const ${constantName} = '${normalizedName}';\n`;

    if (!content.includes(newLine)) {
        content += newLine;
        writeFile(commonTsPath, content); // rewrite entire file as UTF-8
    }
}

// ─── 2. Create a controller file ─────────────────────────────────────────────
function createController(dir, suffix, normalizedName, pascalName, constantName, companyName) {
    const controllerDir = path.join(SRC_PATH, dir, 'controller');
    ensureDir(controllerDir);

    const controllerName = `${pascalName}${suffix}`;
    const filePath = path.join(controllerDir, `${normalizedName}.controller.ts`);

    const content = `import { Controller, Get } from '@nestjs/common';
import { ${constantName} } from '../../constant/common';

@Controller(${constantName})
export class ${controllerName} {
  @Get()
  getHello(): string {
    return 'Hello from ${companyName} ${suffix}';
  }
}
`;
    writeFile(filePath, content);
    return controllerName;
}

// ─── 3. Update / create a module file ────────────────────────────────────────
/**
 * Uses // IMPORTS_START and // CONTROLLERS_START markers (your actual file format).
 * Creates the module from scratch with those markers if it doesn't exist yet.
 */
function updateModule(modulePath, moduleName, controllerName, normalizedName) {
    let content = readFile(modulePath);

    // ── Build fresh module if missing ────────────────────────────────────────
    if (!content.includes('@Module')) {
        content = `import { Module } from '@nestjs/common';

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class ${moduleName}Module {}
`;
    }

    // ── Add import statement ─────────────────────────────────────────────────
    const importStatement = `import { ${controllerName} } from './controller/${normalizedName}.controller';`;
    if (!content.includes(importStatement)) {
        // Insert before @Module(...)
        content = content.replace(
            /(@Module\()/,
            `${importStatement}\n$1`
        );
    }

    // ── Add controller into controllers: [...] array ─────────────────────────
    const controllersArrayMatch = content.match(/controllers:\s*\[([^\]]*)\]/s);
    const alreadyInArray = controllersArrayMatch && controllersArrayMatch[1].includes(controllerName);

    if (!alreadyInArray) {
        const indentMatch = content.match(/^( +)\w/m);
        const indent = indentMatch ? indentMatch[1] : '  ';
        const innerIndent = indent + indent;
        const PRINT_WIDTH = 80;

        content = content.replace(
            /controllers:\s*\[([^\]]*)\]/s,
            (match, inner) => {
                const trimmed = inner.trim();
                const entries = trimmed === '' ? [] : trimmed.split(',').map(e => e.trim()).filter(Boolean);
                entries.push(controllerName);

                // Mirror prettier: inline if the full line fits within printWidth
                const inlineStr = `controllers: [${entries.join(', ')}]`;
                const fullInlineLine = indent + inlineStr + ',';

                if (fullInlineLine.length <= PRINT_WIDTH) {
                    return inlineStr;
                } else {
                    const lines = entries.map(e => `${innerIndent}${e}`).join(',\n');
                    return `controllers: [\n${lines},\n${indent}]`;
                }
            }
        );
    }

    writeFile(modulePath, content);
}

// ─── 4. Create middleware file ────────────────────────────────────────────────
function createMiddleware(normalizedName, pascalName, middlewareName, companyName) {
    const middlewareDir = path.join(SRC_PATH, 'utils', 'middlewares');
    ensureDir(middlewareDir);

    const content = `import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class ${middlewareName} implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    console.log('${companyName} Middleware executing...');
    next();
  }
}
`;
    writeFile(path.join(middlewareDir, `${normalizedName}.middleware.ts`), content);
}

// ─── 5. Update app.module.ts ──────────────────────────────────────────────────
function updateAppModule(normalizedName, middlewareName) {
    const appModulePath = path.join(SRC_PATH, 'app.module.ts');
    if (!fs.existsSync(appModulePath)) {
        throw new Error(`app.module.ts not found at ${appModulePath}`);
    }

    let content = readFile(appModulePath);

    // ── Ensure NestModule + MiddlewareConsumer are imported ──────────────────
    if (!content.includes('NestModule') || !content.includes('MiddlewareConsumer')) {
        content = content.replace(
            /import\s*\{[^}]*\}\s*from\s*'@nestjs\/common'/,
            "import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common'"
        );
    }

    // ── Add middleware import - insert before the first existing import line ──
    const mwImportLine = `import { ${middlewareName} } from './utils/middlewares/${normalizedName}.middleware';`;
    if (!content.includes(mwImportLine)) {
        // Find the first import line and insert our new import before it
        content = content.replace(
            /^(import\s)/m,
            `${mwImportLine}\n$1`
        );
    }

    // ── Check if configure() already exists ──────────────────────────────────
    if (!content.includes('configure(consumer: MiddlewareConsumer)')) {
        content = content.replace(
            /export class AppModule(\s+implements NestModule)?\s*\{/,
            `export class AppModule implements NestModule {`
        );
        // Add configure() before the closing brace of AppModule
        content = content.replace(
            /export class AppModule implements NestModule\s*\{([^}]*)\}/s,
            `export class AppModule implements NestModule {$1
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(${middlewareName})
      .forRoutes('*');
  }
}`
        );
    } else {
        // Append new middleware to existing .apply(...)
        content = content.replace(
            /\.apply\(([^)]+)\)/,
            (match, args) => {
                const existing = args.trim();
                if (existing.includes(middlewareName)) return match;
                return `.apply(${existing}, ${middlewareName})`;
            }
        );
    }

    writeFile(appModulePath, content);
}

// ─── MAIN ROUTE ───────────────────────────────────────────────────────────────
app.post('/generate', (req, res) => {
    const { partner_company_name: companyName } = req.body;

    if (!companyName) {
        return res.status(400).json({ error: 'partner_company_name is required' });
    }

    try {
        const normalizedName = companyName.toLowerCase().replace(/\s+/g, '_');
        const pascalName     = toPascalCase(normalizedName);
        const constantName   = toConstantCase(normalizedName);
        const middlewareName = `${pascalName}Middleware`;

        // 1. Constant
        addConstant(normalizedName, constantName);

        // 2. Controllers
        const enachController    = createController('enach',    'EnachController',    normalizedName, pascalName, constantName, companyName);
        const locationController = createController('location', 'LocationController', normalizedName, pascalName, constantName, companyName);

        // 3. Modules
        updateModule(
            path.join(SRC_PATH, 'enach', 'enach.module.ts'),
            'Enach',
            enachController,
            normalizedName
        );
        updateModule(
            path.join(SRC_PATH, 'location', 'location.module.ts'),
            'Location',
            locationController,
            normalizedName
        );

        // 4. Middleware
        createMiddleware(normalizedName, pascalName, middlewareName, companyName);

        // 5. app.module.ts
        updateAppModule(normalizedName, middlewareName);

        return res.status(201).json({
            status: 'success',
            message: `API components for "${companyName}" created successfully`,
            details: {
                constant: `${constantName} = '${normalizedName}'`,
                controllers: [enachController, locationController],
                modules: ['enach/enach.module.ts', 'location/location.module.ts'],
                middleware: middlewareName,
                appModule: 'app.module.ts updated'
            }
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = 3000;
const server = app.listen(PORT, () => {
    console.log(`\n✅  Generation server running → http://localhost:${PORT}`);
    console.log('   POST /generate  { "partner_company_name": "My Company" }');
    console.log('   Press Ctrl+C to stop.\n');
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`❌  Port ${PORT} already in use. Kill the old process or change PORT.`);
    } else {
        console.error('Server error:', e);
    }
});

process.on('uncaughtException',    (err)           => { console.error('Uncaught exception:', err);   process.exit(1); });
process.on('unhandledRejection',   (reason, promise) => { console.error('Unhandled rejection:', reason); process.exit(1); });