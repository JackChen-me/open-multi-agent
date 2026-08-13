import { readFile } from 'node:fs/promises'
import {
  maintainerRuntimeCodingContractSchema,
  maintainerRuntimeCodingResultSchema,
  maintainerRuntimeValidationContractSchema,
  maintainerRuntimeValidationResultSchema,
  type MaintainerRuntimeCodingContract,
  type MaintainerRuntimeValidationContract,
  type ValidationResult,
} from '@open-multi-agent/maintainer-bot'

export {
  maintainerRuntimeCodingContractSchema,
  maintainerRuntimeCodingResultSchema,
  maintainerRuntimeValidationContractSchema,
  maintainerRuntimeValidationResultSchema,
  type MaintainerRuntimeCodingContract,
  type MaintainerRuntimeValidationContract,
}

export async function readMaintainerRuntimeCodingContract(
  path: string,
): Promise<MaintainerRuntimeCodingContract> {
  return maintainerRuntimeCodingContractSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  )
}

export async function readMaintainerRuntimeValidationContract(
  path: string,
): Promise<MaintainerRuntimeValidationContract> {
  return maintainerRuntimeValidationContractSchema.parse(
    JSON.parse(await readFile(path, 'utf8')),
  )
}

export function createMaintainerRuntimeCodingResult(input: {
  readonly turns: number
  readonly terminationReason: string
  readonly safeEventCount: number
}): ReturnType<typeof maintainerRuntimeCodingResultSchema.parse> {
  return maintainerRuntimeCodingResultSchema.parse({
    status: 'CODING_COMPLETED',
    ...input,
  })
}

export function createMaintainerRuntimeValidationResult(
  validationResults: readonly ValidationResult[],
): ReturnType<typeof maintainerRuntimeValidationResultSchema.parse> {
  return maintainerRuntimeValidationResultSchema.parse({
    status: 'VALIDATION_COMPLETED',
    validationResults: [...validationResults],
  })
}
