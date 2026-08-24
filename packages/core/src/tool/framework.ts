/**
 * Tool definition framework for open-multi-agent.
 *
 * Provides the core primitives for declaring, registering, and converting
 * tools to the JSON Schema format that LLM APIs expect.
 *
 * Types shared with the rest of the framework (`ToolDefinition`, `ToolResult`,
 * `ToolUseContext`) are imported from `../types` to ensure a single source of
 * truth.  This file re-exports them for the convenience of downstream callers
 * who only need to import from `tool/framework`.
 */

import { type ZodSchema } from 'zod'
import type {
  ToolDefinition,
  ToolResult,
  ToolUseContext,
  LLMToolDef,
} from '../types.js'

// Re-export so consumers can `import { ToolDefinition } from './framework.js'`
export type { ToolDefinition, ToolResult, ToolUseContext }

// ---------------------------------------------------------------------------
// LLM-facing JSON Schema types
// ---------------------------------------------------------------------------

/** Minimal JSON Schema for a single property. */
export type JSONSchemaProperty =
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number'; description?: string }
  | { type: 'integer'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { type: 'array'; items: JSONSchemaProperty; description?: string }
  | {
      type: 'object'
      properties: Record<string, JSONSchemaProperty>
      required?: string[]
      description?: string
    }
  | { anyOf: JSONSchemaProperty[]; description?: string }
  | { const: unknown; description?: string }
  // Fallback for types we don't explicitly model
  | Record<string, unknown>

// ---------------------------------------------------------------------------
// defineTool
// ---------------------------------------------------------------------------

/**
 * Define a typed tool.  This is the single entry-point for creating tools
 * that can be registered with a {@link ToolRegistry}.
 *
 * The returned object satisfies the {@link ToolDefinition} interface imported
 * from `../types`.
 *
 * @example
 * ```ts
 * const echoTool = defineTool({
 *   name: 'echo',
 *   description: 'Echo the input message back to the caller.',
 *   inputSchema: z.object({ message: z.string() }),
 *   execute: async ({ message }) => ({
 *     data: message,
 *     isError: false,
 *   }),
 * })
 * ```
 */
export function defineTool<TInput, TData = string>(config: {
  name: string
  description: string
  inputSchema: ZodSchema<TInput>
  /**
   * Marks a tool whose grant permits real side effects. Defaults to false.
   */
  consequential?: boolean
  /**
   * Optional runtime validator for `ToolResult.data`.
   * When omitted, output validation is skipped.
   *
   * The schema validates the application-owned `ToolResult.data`. Existing
   * string tools may keep using `z.string()`; rich tools can validate objects.
   */
  outputSchema?: ZodSchema<TData>
  /**
   * Optional JSON Schema for the LLM (bypasses Zod → JSON Schema conversion).
   */
  llmInputSchema?: Record<string, unknown>
  /**
   * Per-tool maximum output length in characters. When set, tool output
   * exceeding this limit is truncated (head + tail with a marker in between).
   * Takes priority over agent-level `maxToolOutputChars`.
   */
  maxOutputChars?: number
  execute: (input: TInput, context: ToolUseContext) => Promise<ToolResult<TData>>
}): ToolDefinition<TInput, TData> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    ...(config.consequential !== undefined
      ? { consequential: config.consequential }
      : {}),
    ...(config.outputSchema !== undefined
      ? { outputSchema: config.outputSchema }
      : {}),
    ...(config.llmInputSchema !== undefined
      ? { llmInputSchema: config.llmInputSchema }
      : {}),
    ...(config.maxOutputChars !== undefined
      ? { maxOutputChars: config.maxOutputChars }
      : {}),
    execute: config.execute,
  }
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that holds a set of named tools and can produce the JSON Schema
 * representation expected by LLM APIs (Anthropic, OpenAI, etc.).
 */
export class ToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<string, ToolDefinition<any, any>>()
  private readonly runtimeToolNames = new Set<string>()

  /**
   * Add a tool to the registry.  Throws if a tool with the same name has
   * already been registered — prevents silent overwrites.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(
    tool: ToolDefinition<any, any>,
    options?: { runtimeAdded?: boolean },
  ): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `ToolRegistry: a tool named "${tool.name}" is already registered. ` +
          'Use a unique name or deregister the existing one first.',
      )
    }
    this.tools.set(tool.name, tool)
    if (options?.runtimeAdded === true) {
      this.runtimeToolNames.add(tool.name)
    }
  }

  /** Return a tool by name, or `undefined` if not found. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name)
  }

  /**
   * Return all registered tool definitions as an array.
   *
   * Callers that only need names can do `registry.list().map(t => t.name)`.
   * This matches the agent's `getTools()` pattern.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  list(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values())
  }

  /**
   * Return all registered tool definitions as an array.
   * Alias for {@link list} — available for callers that prefer explicit naming.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values())
  }

  /** Return true when a tool with the given name is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /**
   * Remove a tool by name.
   * No-op if the tool was not registered — matches the agent's expected
   * behaviour where `removeTool` is a graceful operation.
   */
  unregister(name: string): void {
    this.tools.delete(name)
    this.runtimeToolNames.delete(name)
  }

  /** Alias for {@link unregister} — available for symmetry with `register`. */
  deregister(name: string): void {
    this.unregister(name)
  }

  /**
   * Convert all registered tools to the {@link LLMToolDef} format used by LLM
   * adapters.  This is the primary method called by the agent runner before
   * each LLM API call.
   */
  toToolDefs(): LLMToolDef[] {
    return Array.from(this.tools.values()).map((tool) => {
      const schema =
        tool.llmInputSchema ?? zodToJsonSchema(tool.inputSchema)
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: schema,
      } satisfies LLMToolDef
    })
  }

  /**
   * Return only tools that were added dynamically at runtime (e.g. via
   * `agent.addTool()`), in LLM definition format.
   */
  toRuntimeToolDefs(): LLMToolDef[] {
    return this.toToolDefs().filter(tool => this.runtimeToolNames.has(tool.name))
  }

  /**
   * Convert all registered tools to the Anthropic-style `input_schema`
   * format.  Prefer {@link toToolDefs} for normal use; this method is exposed
   * for callers that construct their own API payloads.
   */
  toLLMTools(): Array<{
    name: string
    description: string
    /** Anthropic-style tool input JSON Schema (`type` is usually `object`). */
    input_schema: Record<string, unknown>
  }> {
    return Array.from(this.tools.values()).map((tool) => {
      if (tool.llmInputSchema !== undefined) {
        return {
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: 'object' as const,
            ...(tool.llmInputSchema as Record<string, unknown>),
          },
        }
      }
      const schema = zodToJsonSchema(tool.inputSchema)
      return {
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: 'object' as const,
          properties:
            (schema.properties as Record<string, JSONSchemaProperty>) ?? {},
          ...(schema.required !== undefined
            ? { required: schema.required as string[] }
            : {}),
        },
      }
    })
  }
}

// ---------------------------------------------------------------------------
// zodToJsonSchema
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema to a plain JSON Schema object suitable for inclusion
 * in LLM API calls.
 *
 * Supported Zod types:
 *   z.string(), z.number(), z.boolean(), z.enum(), z.array(), z.object(),
 *   z.optional(), z.union(), z.literal(), z.describe(), z.nullable(),
 *   z.default(), z.intersection(), z.discriminatedUnion(), z.record(),
 *   z.tuple(), z.any(), z.unknown(), z.never(), z.effects() (transforms)
 *
 * Unsupported types fall back to `{}` (any) which is still valid JSON Schema.
 */
export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  return convertZodType(schema)
}

// Internal recursive converter.  We access Zod's internal `_def` structure
// because Zod v3 does not ship a first-class JSON Schema exporter.
function convertZodType(schema: ZodSchema): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def as ZodTypeDef

  const description: string | undefined = def.description

  const withDesc = (result: Record<string, unknown>): Record<string, unknown> =>
    description !== undefined ? { ...result, description } : result

  switch (def.typeName) {
    // -----------------------------------------------------------------------
    // Primitives
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodString:
      return withDesc({ type: 'string' })

    case ZodTypeName.ZodNumber:
      return withDesc({ type: 'number' })

    case ZodTypeName.ZodBigInt:
      return withDesc({ type: 'integer' })

    case ZodTypeName.ZodBoolean:
      return withDesc({ type: 'boolean' })

    case ZodTypeName.ZodNull:
      return withDesc({ type: 'null' })

    case ZodTypeName.ZodUndefined:
      return withDesc({ type: 'null' })

    case ZodTypeName.ZodDate:
      return withDesc({ type: 'string', format: 'date-time' })

    // -----------------------------------------------------------------------
    // Literals
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodLiteral: {
      const literalDef = def as ZodLiteralDef
      return withDesc({ const: literalDef.value })
    }

    // -----------------------------------------------------------------------
    // Enums
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodEnum: {
      const enumDef = def as ZodEnumDef
      return withDesc({ type: 'string', enum: enumDef.values })
    }

    case ZodTypeName.ZodNativeEnum: {
      const nativeEnumDef = def as ZodNativeEnumDef
      const values = Object.values(nativeEnumDef.values as object).filter(
        (v) => typeof v === 'string' || typeof v === 'number',
      )
      return withDesc({ enum: values })
    }

    // -----------------------------------------------------------------------
    // Arrays
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodArray: {
      const arrayDef = def as ZodArrayDef
      return withDesc({
        type: 'array',
        items: convertZodType(arrayDef.type),
      })
    }

    case ZodTypeName.ZodTuple: {
      const tupleDef = def as ZodTupleDef
      return withDesc({
        type: 'array',
        prefixItems: tupleDef.items.map(convertZodType),
      })
    }

    // -----------------------------------------------------------------------
    // Objects
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodObject: {
      const objectDef = def as ZodObjectDef
      const properties: Record<string, unknown> = {}
      const required: string[] = []

      for (const [key, value] of Object.entries(objectDef.shape())) {
        properties[key] = convertZodType(value as ZodSchema)

        if (!(value as ZodSchema).isOptional()) {
          required.push(key)
        }
      }

      const result: Record<string, unknown> = { type: 'object', properties }
      if (required.length > 0) result.required = required
      return withDesc(result)
    }

    case ZodTypeName.ZodRecord: {
      const recordDef = def as ZodRecordDef
      return withDesc({
        type: 'object',
        additionalProperties: convertZodType(recordDef.valueType),
      })
    }

    // -----------------------------------------------------------------------
    // Optional / Nullable / Default
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodOptional: {
      const optionalDef = def as ZodOptionalDef
      const inner = convertZodType(optionalDef.innerType)
      return description !== undefined ? { ...inner, description } : inner
    }

    case ZodTypeName.ZodNullable: {
      const nullableDef = def as ZodNullableDef
      const inner = convertZodType(nullableDef.innerType)
      const type = inner.type
      if (typeof type === 'string') {
        return withDesc({ ...inner, type: [type, 'null'] })
      }
      return withDesc({ anyOf: [inner, { type: 'null' }] })
    }

    case ZodTypeName.ZodDefault: {
      const defaultDef = def as ZodDefaultDef
      const inner = convertZodType(defaultDef.innerType)
      return withDesc({ ...inner, default: defaultDef.defaultValue() })
    }

    // -----------------------------------------------------------------------
    // Union / Intersection / Discriminated Union
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodUnion: {
      const unionDef = def as ZodUnionDef
      const options = (unionDef.options as ZodSchema[]).map(convertZodType)
      return withDesc({ anyOf: options })
    }

    case ZodTypeName.ZodDiscriminatedUnion: {
      const duDef = def as ZodDiscriminatedUnionDef
      const options = (duDef.options as ZodSchema[]).map(convertZodType)
      return withDesc({ anyOf: options })
    }

    case ZodTypeName.ZodIntersection: {
      const intDef = def as ZodIntersectionDef
      return withDesc({
        allOf: [convertZodType(intDef.left), convertZodType(intDef.right)],
      })
    }

    // -----------------------------------------------------------------------
    // Wrappers that forward to their inner type
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodEffects: {
      const effectsDef = def as ZodEffectsDef
      const inner = convertZodType(effectsDef.schema)
      return description !== undefined ? { ...inner, description } : inner
    }

    case ZodTypeName.ZodBranded: {
      const brandedDef = def as ZodBrandedDef
      return withDesc(convertZodType(brandedDef.type))
    }

    case ZodTypeName.ZodReadonly: {
      const readonlyDef = def as ZodReadonlyDef
      return withDesc(convertZodType(readonlyDef.innerType))
    }

    case ZodTypeName.ZodCatch: {
      const catchDef = def as ZodCatchDef
      return withDesc(convertZodType(catchDef.innerType))
    }

    case ZodTypeName.ZodPipeline: {
      const pipelineDef = def as ZodPipelineDef
      return withDesc(convertZodType(pipelineDef.in))
    }

    // -----------------------------------------------------------------------
    // Any / Unknown – JSON Schema wildcard
    // -----------------------------------------------------------------------
    case ZodTypeName.ZodAny:
    case ZodTypeName.ZodUnknown:
      return withDesc({})

    case ZodTypeName.ZodNever:
      return withDesc({ not: {} })

    case ZodTypeName.ZodVoid:
      return withDesc({ type: 'null' })

    // -----------------------------------------------------------------------
    // Fallback
    // -----------------------------------------------------------------------
    default:
      return withDesc({})
  }
}

// ---------------------------------------------------------------------------
// Internal Zod type-name enum (mirrors Zod's internal ZodFirstPartyTypeKind)
// ---------------------------------------------------------------------------

const enum ZodTypeName {
  ZodString = 'ZodString',
  ZodNumber = 'ZodNumber',
  ZodBigInt = 'ZodBigInt',
  ZodBoolean = 'ZodBoolean',
  ZodDate = 'ZodDate',
  ZodUndefined = 'ZodUndefined',
  ZodNull = 'ZodNull',
  ZodAny = 'ZodAny',
  ZodUnknown = 'ZodUnknown',
  ZodNever = 'ZodNever',
  ZodVoid = 'ZodVoid',
  ZodArray = 'ZodArray',
  ZodObject = 'ZodObject',
  ZodUnion = 'ZodUnion',
  ZodDiscriminatedUnion = 'ZodDiscriminatedUnion',
  ZodIntersection = 'ZodIntersection',
  ZodTuple = 'ZodTuple',
  ZodRecord = 'ZodRecord',
  ZodMap = 'ZodMap',
  ZodSet = 'ZodSet',
  ZodFunction = 'ZodFunction',
  ZodLazy = 'ZodLazy',
  ZodLiteral = 'ZodLiteral',
  ZodEnum = 'ZodEnum',
  ZodEffects = 'ZodEffects',
  ZodNativeEnum = 'ZodNativeEnum',
  ZodOptional = 'ZodOptional',
  ZodNullable = 'ZodNullable',
  ZodDefault = 'ZodDefault',
  ZodCatch = 'ZodCatch',
  ZodPromise = 'ZodPromise',
  ZodBranded = 'ZodBranded',
  ZodPipeline = 'ZodPipeline',
  ZodReadonly = 'ZodReadonly',
}

// ---------------------------------------------------------------------------
// Internal Zod _def structure typings (narrow only what we access)
// ---------------------------------------------------------------------------

interface ZodTypeDef {
  typeName: string
  description?: string
}

interface ZodLiteralDef extends ZodTypeDef {
  value: unknown
}

interface ZodEnumDef extends ZodTypeDef {
  values: string[]
}

interface ZodNativeEnumDef extends ZodTypeDef {
  values: object
}

interface ZodArrayDef extends ZodTypeDef {
  type: ZodSchema
}

interface ZodTupleDef extends ZodTypeDef {
  items: ZodSchema[]
}

interface ZodObjectDef extends ZodTypeDef {
  shape: () => Record<string, ZodSchema>
}

interface ZodRecordDef extends ZodTypeDef {
  valueType: ZodSchema
}

interface ZodUnionDef extends ZodTypeDef {
  options: unknown
}

interface ZodDiscriminatedUnionDef extends ZodTypeDef {
  options: unknown
}

interface ZodIntersectionDef extends ZodTypeDef {
  left: ZodSchema
  right: ZodSchema
}

interface ZodOptionalDef extends ZodTypeDef {
  innerType: ZodSchema
}

interface ZodNullableDef extends ZodTypeDef {
  innerType: ZodSchema
}

interface ZodDefaultDef extends ZodTypeDef {
  innerType: ZodSchema
  defaultValue: () => unknown
}

interface ZodEffectsDef extends ZodTypeDef {
  schema: ZodSchema
}

interface ZodBrandedDef extends ZodTypeDef {
  type: ZodSchema
}

interface ZodReadonlyDef extends ZodTypeDef {
  innerType: ZodSchema
}

interface ZodCatchDef extends ZodTypeDef {
  innerType: ZodSchema
}

interface ZodPipelineDef extends ZodTypeDef {
  in: ZodSchema
}
