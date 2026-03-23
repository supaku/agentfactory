import { describe, it, expect } from 'vitest'
import { PythonExtractor } from '../python-extractor.js'
import { GoExtractor } from '../go-extractor.js'
import { RustExtractor } from '../rust-extractor.js'
import { SymbolExtractor } from '../symbol-extractor.js'

// ── Python ────────────────────────────────────────────────────────────

const samplePython = `
import os
from typing import List, Optional
from dataclasses import dataclass

@dataclass
class User:
    name: str
    email: str

    def full_name(self) -> str:
        return self.name

class _InternalHelper:
    pass

def process_data(items: List[str]) -> List[str]:
    return [item.strip() for item in items]

async def fetch_users(url: str) -> List[User]:
    pass

_private_func = lambda x: x

MAX_RETRIES = 3
`

describe('PythonExtractor', () => {
  const extractor = new PythonExtractor()

  it('extracts imports', () => {
    const result = extractor.extract(samplePython, 'main.py')
    expect(result.imports).toContain('os')
    expect(result.imports).toContain('typing')
  })

  it('extracts classes', () => {
    const result = extractor.extract(samplePython, 'main.py')
    const user = result.symbols.find(s => s.name === 'User' && s.kind === 'class')
    expect(user).toBeDefined()
    expect(user!.exported).toBe(true)
  })

  it('marks internal classes as not exported', () => {
    const result = extractor.extract(samplePython, 'main.py')
    const internal = result.symbols.find(s => s.name === '_InternalHelper')
    expect(internal).toBeDefined()
    expect(internal!.exported).toBe(false)
  })

  it('extracts functions', () => {
    const result = extractor.extract(samplePython, 'main.py')
    const fn = result.symbols.find(s => s.name === 'process_data' && s.kind === 'function')
    expect(fn).toBeDefined()
    expect(fn!.exported).toBe(true)
  })

  it('extracts async functions', () => {
    const result = extractor.extract(samplePython, 'main.py')
    const fn = result.symbols.find(s => s.name === 'fetch_users' && s.kind === 'function')
    expect(fn).toBeDefined()
  })

  it('extracts methods', () => {
    const result = extractor.extract(samplePython, 'main.py')
    const method = result.symbols.find(s => s.name === 'full_name' && s.kind === 'method')
    expect(method).toBeDefined()
  })

  it('extracts decorators', () => {
    const result = extractor.extract(samplePython, 'main.py')
    const dec = result.symbols.find(s => s.name === 'dataclass' && s.kind === 'decorator')
    expect(dec).toBeDefined()
  })

  it('sets language to python', () => {
    const result = extractor.extract(samplePython, 'main.py')
    expect(result.language).toBe('python')
    for (const s of result.symbols) {
      expect(s.language).toBe('python')
    }
  })
})

// ── Go ────────────────────────────────────────────────────────────────

const sampleGo = `
package main

import (
	"fmt"
	"net/http"
)

// Server represents an HTTP server
type Server struct {
	Port int
	Host string
}

// Handler is the request handler interface
type Handler interface {
	ServeHTTP(w http.ResponseWriter, r *http.Request)
}

type myInternal struct{}

// NewServer creates a new Server instance
func NewServer(port int) *Server {
	return &Server{Port: port}
}

// Start starts the server
func (s *Server) Start() error {
	return http.ListenAndServe(fmt.Sprintf("%s:%d", s.Host, s.Port), nil)
}

func (s *Server) internal() {}

var DefaultPort = 8080
const Version = "1.0"
`

describe('GoExtractor', () => {
  const extractor = new GoExtractor()

  it('extracts imports', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    expect(result.imports).toContain('fmt')
    expect(result.imports).toContain('net/http')
  })

  it('extracts structs', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const srv = result.symbols.find(s => s.name === 'Server' && s.kind === 'struct')
    expect(srv).toBeDefined()
    expect(srv!.exported).toBe(true)
  })

  it('extracts interfaces', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const handler = result.symbols.find(s => s.name === 'Handler' && s.kind === 'interface')
    expect(handler).toBeDefined()
    expect(handler!.exported).toBe(true)
  })

  it('marks unexported types', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const internal = result.symbols.find(s => s.name === 'myInternal')
    expect(internal).toBeDefined()
    expect(internal!.exported).toBe(false)
  })

  it('extracts functions', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const fn = result.symbols.find(s => s.name === 'NewServer' && s.kind === 'function')
    expect(fn).toBeDefined()
    expect(fn!.exported).toBe(true)
    expect(fn!.documentation).toContain('creates a new Server instance')
  })

  it('extracts methods with receivers', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const method = result.symbols.find(s => s.name === 'Start' && s.kind === 'method')
    expect(method).toBeDefined()
    expect(method!.parentName).toBe('Server')
    expect(method!.exported).toBe(true)
  })

  it('marks unexported methods', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const method = result.symbols.find(s => s.name === 'internal' && s.kind === 'method')
    expect(method).toBeDefined()
    expect(method!.exported).toBe(false)
  })

  it('extracts variables and constants', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    const v = result.symbols.find(s => s.name === 'DefaultPort')
    expect(v).toBeDefined()
    const c = result.symbols.find(s => s.name === 'Version')
    expect(c).toBeDefined()
  })

  it('sets language to go', () => {
    const result = extractor.extract(sampleGo, 'main.go')
    expect(result.language).toBe('go')
  })
})

// ── Rust ──────────────────────────────────────────────────────────────

const sampleRust = `
use std::io::{self, Read};
use serde::{Serialize, Deserialize};

/// A configuration struct
pub struct Config {
    pub name: String,
    pub version: u32,
}

struct InternalState {
    data: Vec<u8>,
}

/// The main trait for services
pub trait Service {
    fn handle(&self, request: Request) -> Response;
}

impl Service for Config {
    fn handle(&self, request: Request) -> Response {
        unimplemented!()
    }
}

impl Config {
    pub fn new(name: String) -> Self {
        Config { name, version: 1 }
    }
}

/// Process incoming data
pub async fn process(data: &[u8]) -> io::Result<Vec<u8>> {
    Ok(data.to_vec())
}

fn internal_helper() -> bool {
    true
}

pub enum Status {
    Active,
    Inactive,
}

macro_rules! log_error {
    ($msg:expr) => {
        eprintln!("ERROR: {}", $msg);
    };
}

pub const MAX_SIZE: usize = 1024;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub mod utils;
`

describe('RustExtractor', () => {
  const extractor = new RustExtractor()

  it('extracts use statements', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    expect(result.imports).toContain('std::io::{self, Read}')
    expect(result.imports).toContain('serde::{Serialize, Deserialize}')
  })

  it('extracts pub structs', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const cfg = result.symbols.find(s => s.name === 'Config' && s.kind === 'struct')
    expect(cfg).toBeDefined()
    expect(cfg!.exported).toBe(true)
    expect(cfg!.documentation).toContain('configuration struct')
  })

  it('marks private structs', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const internal = result.symbols.find(s => s.name === 'InternalState')
    expect(internal).toBeDefined()
    expect(internal!.exported).toBe(false)
  })

  it('extracts traits', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const trait_ = result.symbols.find(s => s.name === 'Service' && s.kind === 'trait')
    expect(trait_).toBeDefined()
    expect(trait_!.exported).toBe(true)
  })

  it('extracts impl blocks', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const impls = result.symbols.filter(s => s.kind === 'impl')
    expect(impls.length).toBeGreaterThanOrEqual(2)
    const traitImpl = impls.find(s => s.name.includes('Service for Config'))
    expect(traitImpl).toBeDefined()
  })

  it('extracts functions', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const fn_ = result.symbols.find(s => s.name === 'process' && s.kind === 'function')
    expect(fn_).toBeDefined()
    expect(fn_!.exported).toBe(true)
    expect(fn_!.documentation).toContain('Process incoming data')
  })

  it('marks private functions', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const fn_ = result.symbols.find(s => s.name === 'internal_helper')
    expect(fn_).toBeDefined()
    expect(fn_!.exported).toBe(false)
  })

  it('extracts enums', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const en = result.symbols.find(s => s.name === 'Status' && s.kind === 'enum')
    expect(en).toBeDefined()
    expect(en!.exported).toBe(true)
  })

  it('extracts macros', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    const macro_ = result.symbols.find(s => s.name === 'log_error' && s.kind === 'macro')
    expect(macro_).toBeDefined()
  })

  it('extracts const/type/mod', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    expect(result.symbols.find(s => s.name === 'MAX_SIZE' && s.kind === 'variable')).toBeDefined()
    expect(result.symbols.find(s => s.name === 'Result' && s.kind === 'type')).toBeDefined()
    expect(result.symbols.find(s => s.name === 'utils' && s.kind === 'module')).toBeDefined()
  })

  it('sets language to rust', () => {
    const result = extractor.extract(sampleRust, 'lib.rs')
    expect(result.language).toBe('rust')
  })
})

// ── Multi-language registration ───────────────────────────────────────

describe('SymbolExtractor multi-language', () => {
  it('registers additional extractors', () => {
    const extractor = new SymbolExtractor()
    extractor.registerExtractor(new PythonExtractor())
    extractor.registerExtractor(new GoExtractor())
    extractor.registerExtractor(new RustExtractor())

    expect(extractor.supportsLanguage('python')).toBe(true)
    expect(extractor.supportsLanguage('go')).toBe(true)
    expect(extractor.supportsLanguage('rust')).toBe(true)
  })

  it('extracts Python from source', () => {
    const extractor = new SymbolExtractor()
    extractor.registerExtractor(new PythonExtractor())
    const result = extractor.extractFromSource('def hello(): pass', 'test.py')
    expect(result.symbols.length).toBeGreaterThan(0)
    expect(result.language).toBe('python')
  })

  it('extracts Go from source', () => {
    const extractor = new SymbolExtractor()
    extractor.registerExtractor(new GoExtractor())
    const result = extractor.extractFromSource('func main() {}', 'main.go')
    expect(result.symbols.length).toBeGreaterThan(0)
    expect(result.language).toBe('go')
  })

  it('extracts Rust from source', () => {
    const extractor = new SymbolExtractor()
    extractor.registerExtractor(new RustExtractor())
    const result = extractor.extractFromSource('pub fn main() {}', 'main.rs')
    expect(result.symbols.length).toBeGreaterThan(0)
    expect(result.language).toBe('rust')
  })

  it('all languages map to unified SymbolKind types', () => {
    const validKinds = new Set([
      'function', 'class', 'interface', 'type', 'variable', 'method',
      'property', 'import', 'export', 'enum', 'struct', 'trait',
      'impl', 'macro', 'decorator', 'module',
    ])

    const extractor = new SymbolExtractor()
    extractor.registerExtractor(new PythonExtractor())
    extractor.registerExtractor(new GoExtractor())
    extractor.registerExtractor(new RustExtractor())

    const py = extractor.extractFromSource(samplePython, 'test.py')
    const go = extractor.extractFromSource(sampleGo, 'test.go')
    const rs = extractor.extractFromSource(sampleRust, 'test.rs')

    for (const ast of [py, go, rs]) {
      for (const symbol of ast.symbols) {
        expect(validKinds.has(symbol.kind)).toBe(true)
      }
    }
  })
})
