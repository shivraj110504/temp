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
    if (raw[0] === 0xFF && raw[1] === 0xFE) {
        text = raw.toString('utf16le');
    }
    else if (raw[0] === 0xFE && raw[1] === 0xFF) {
        const swapped = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length - 1; i += 2) { swapped[i] = raw[i+1]; swapped[i+1] = raw[i]; }
        text = swapped.toString('utf16le');
    }
    else if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
        text = raw.slice(3).toString('utf8');
    }
    else {
        text = raw.toString('utf8');
    }

    return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function writeFile(filePath, content) {
    const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    fs.writeFileSync(filePath, normalised, { encoding: 'utf8' });
}

function addConstant(normalizedName, constantName) {
    const commonTsPath = path.join(SRC_PATH, 'constant', 'common.ts');
    ensureDir(path.dirname(commonTsPath));

    let content = readFile(commonTsPath);
    const newLine = `export const ${constantName} = '${normalizedName}';\n`;

    if (!content.includes(newLine)) {
        content += newLine;
        writeFile(commonTsPath, content); 
    }
}

const TEMPLATES = {
    enachController:    path.join(__dirname, 'templates', 'enach.controller.template.ts'),
    locationController: path.join(__dirname, 'templates', 'location.controller.template.ts'),
    middleware:         path.join(__dirname, 'templates', 'middleware.template.ts'),
};

function findFile(rootDir, filename) {
    if (!fs.existsSync(rootDir)) return null;
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            const found = findFile(fullPath, filename);
            if (found) return found;
        } else if (entry.name === filename) {
            return fullPath;
        }
    }
    return null;
}

function relativeImport(fromFile, toFile) {
    const rel = path.relative(path.dirname(fromFile), path.dirname(toFile));
    const base = path.basename(toFile, path.extname(toFile));
    return (rel ? rel + '/' + base : './' + base).replace(/\\/g, '/');
}
function createController(dir, templatePath, suffix, normalizedName, pascalName, constantName, companyName) {
    const controllerDir = path.join(SRC_PATH, dir, 'controller');
    ensureDir(controllerDir);

    const controllerName = `${pascalName}${suffix}`;
    const outputFilePath = path.join(controllerDir, `${normalizedName}.controller.ts`);

    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template file not found: ${templatePath}\nCreate this file first — see templates/ folder.`);
    }

    const commonTsPath = findFile(SRC_PATH, 'common.ts');
    if (!commonTsPath) {
        throw new Error(`Could not find common.ts anywhere under ${SRC_PATH}`);
    }

    const commonImportPath = relativeImport(outputFilePath, commonTsPath);

    let content = readFile(templatePath);
    content = content
        .replace(/__CONTROLLER_NAME__/g,  controllerName)
        .replace(/__CONSTANT_NAME__/g,    constantName)
        .replace(/__NORMALIZED_NAME__/g,  normalizedName)
        .replace(/__COMPANY_NAME__/g,     companyName)
        .replace(/__COMMON_IMPORT_PATH__/g, commonImportPath);

    writeFile(outputFilePath, content);
    return controllerName;
}

function updateModule(modulePath, moduleName, controllerName, normalizedName) {
    let content = readFile(modulePath);

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

    const importStatement = `import { ${controllerName} } from './controller/${normalizedName}.controller';`;
    if (!content.includes(importStatement)) {
        content = content.replace(
            /(@Module\()/,
            `${importStatement}\n$1`
        );
    }

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

function createMiddleware(normalizedName, pascalName, middlewareName, companyName) {
    const middlewareDir = path.join(SRC_PATH, 'utils', 'middlewares');
    ensureDir(middlewareDir);

    if (!fs.existsSync(TEMPLATES.middleware)) {
        throw new Error(`Template file not found: ${TEMPLATES.middleware}\nCreate this file first — see templates/ folder.`);
    }

    let content = readFile(TEMPLATES.middleware);
    content = content
        .replace(/__MIDDLEWARE_NAME__/g,  middlewareName)
        .replace(/__NORMALIZED_NAME__/g,  normalizedName)
        .replace(/__COMPANY_NAME__/g,     companyName);

    writeFile(path.join(middlewareDir, `${normalizedName}.middleware.ts`), content);
}

function updateAppModule(normalizedName, middlewareName) {
    const appModulePath = path.join(SRC_PATH, 'app.module.ts');
    if (!fs.existsSync(appModulePath)) {
        throw new Error(`app.module.ts not found at ${appModulePath}`);
    }

    let content = readFile(appModulePath);

    if (!content.includes('NestModule') || !content.includes('MiddlewareConsumer')) {
        content = content.replace(
            /import\s*\{[^}]*\}\s*from\s*'@nestjs\/common'/,
            "import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common'"
        );
    }

    const mwImportLine = `import { ${middlewareName} } from './utils/middlewares/${normalizedName}.middleware';`;
    if (!content.includes(mwImportLine)) {
        content = content.replace(
            /^(import\s)/m,
            `${mwImportLine}\n$1`
        );
    }

    if (!content.includes('configure(consumer: MiddlewareConsumer)')) {
        content = content.replace(
            /export class AppModule(\s+implements NestModule)?\s*\{/,
            `export class AppModule implements NestModule {`
        );
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

app.post('/generate-partner', (req, res) => {
    const { partner_company_name: companyName } = req.body;

    if (!companyName) {
        return res.status(400).json({ error: 'partner_name is required' });
    }

    try {
        const normalizedName = companyName.toLowerCase().replace(/\s+/g, '_');
        const pascalName     = toPascalCase(normalizedName);
        const constantName   = toConstantCase(normalizedName);
        const middlewareName = `${pascalName}Middleware`;

        addConstant(normalizedName, constantName);

        const enachController    = createController('enach',    TEMPLATES.enachController,    'EnachController',    normalizedName, pascalName, constantName, companyName);
        const locationController = createController('location', TEMPLATES.locationController, 'LocationController', normalizedName, pascalName, constantName, companyName);

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

        createMiddleware(normalizedName, pascalName, middlewareName, companyName);

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

const PORT = 3000;
const server = app.listen(PORT, () => {
    console.log(`\nserver running → http://localhost:${PORT}`);
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} already in use.`);
    } else {
        console.error('Server error:', e);
    }
});

process.on('uncaughtException',    (err)           => { console.error('Uncaught exception:', err);   process.exit(1); });
process.on('unhandledRejection',   (reason, promise) => { console.error('Unhandled rejection:', reason); process.exit(1); });