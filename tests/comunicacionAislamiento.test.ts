import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function listarArchivosTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listarArchivosTs(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(fullPath);
    }
  }
  return files;
}

function obtenerImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    if (m[1]) matches.push(m[1]);
  }
  return matches;
}

describe('Aislamiento de dominios: Motor de Comunicación vs Motor Legal', () => {
  const rootDir = path.resolve(__dirname, '..');
  const dirComunicacion = path.join(rootDir, 'src', 'comunicacion');
  const dirLegal = path.join(rootDir, 'src', 'legal');
  const dirChannels = path.join(rootDir, 'src', 'channels');
  const dirLib = path.join(rootDir, 'src', 'lib');

  it('src/comunicacion no importa nada de src/legal', () => {
    const files = listarArchivosTs(dirComunicacion);
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const imports = obtenerImports(f);
      for (const imp of imports) {
        expect(imp).not.toMatch(/\/legal\b/);
        expect(imp).not.toMatch(/\.\.\/legal/);
      }
    }
  });

  it('src/comunicacion no importa orquestación de cobranza ni servicios de casos/deudas', () => {
    const files = listarArchivosTs(dirComunicacion);

    for (const f of files) {
      const imports = obtenerImports(f);
      for (const imp of imports) {
        expect(imp).not.toMatch(/\/orquestacion\b/);
        expect(imp).not.toMatch(/services\/(casos|deudas|promesas|pagos|contratos)/);
      }
    }
  });

  it('src/legal no importa nada de src/comunicacion', () => {
    const files = listarArchivosTs(dirLegal);
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const imports = obtenerImports(f);
      for (const imp of imports) {
        expect(imp).not.toMatch(/\/comunicacion\b/);
        expect(imp).not.toMatch(/\.\.\/comunicacion/);
      }
    }
  });

  it('src/lib y src/channels no importan src/comunicacion', () => {
    const files = [...listarArchivosTs(dirLib), ...listarArchivosTs(dirChannels)];

    for (const f of files) {
      const imports = obtenerImports(f);
      for (const imp of imports) {
        expect(imp).not.toMatch(/\/comunicacion\b/);
      }
    }
  });
});
