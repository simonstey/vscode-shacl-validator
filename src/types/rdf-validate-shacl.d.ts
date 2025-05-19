// This file extends the rdf-validate-shacl module definitions
// to work around CommonJS/ESM compatibility issues

import * as RDF from "@rdfjs/types";

declare module "rdf-validate-shacl" {
  import { GraphPointer } from "../types/clownface-shim";

  export interface ValidationResult {
    message: RDF.Literal | RDF.Literal[];
    path?: RDF.NamedNode | RDF.BlankNode;
    focusNode?: RDF.NamedNode | RDF.BlankNode;
    severity?: RDF.NamedNode;
    sourceConstraintComponent?: RDF.NamedNode | RDF.BlankNode;
    sourceShape?: RDF.NamedNode | RDF.BlankNode;
    value?: RDF.NamedNode | RDF.BlankNode | RDF.Literal;
  }

  export interface ValidationReport<F = any> {
    conforms: boolean;
    results: ValidationResult[];
    dataset: RDF.DatasetCore;
    term: GraphPointer;
  }
}
