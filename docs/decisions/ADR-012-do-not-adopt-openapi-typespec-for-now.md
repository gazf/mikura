## ADR-012: Do not adopt OpenAPI / TypeSpec (for now)

**Decision**: API schema definition files (OpenAPI, TypeSpec) will not be introduced at this point.

**Rejection rationale**:

- The API is still in flux; maintenance cost of schema definitions is high
- AI-driven code generation can handle type alignment
- The value of hand-written OpenAPI has dropped sharply

**Conditions for future adoption**:

- The API has stabilized
- Plans emerge to build clients in other languages (macOS, iOS, Web)
- An enterprise customer requires a spec document

---
