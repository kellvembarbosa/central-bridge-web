/**
 * Error envelope of the Bridge contract (§4). Framework-free.
 */
export const BRIDGE_ERRORS = {
  unauthorized: { status: 401, message: 'Requisição sem autenticação válida da Central.' },
  signature_invalid: { status: 401, message: 'Assinatura da Central inválida.' },
  timestamp_skew: {
    status: 401,
    message: 'Requisição expirada: o relógio difere em mais de 5 minutos.',
  },
  ip_not_allowed: { status: 403, message: 'Endereço IP não autorizado.' },
  not_found: { status: 404, message: 'Recurso não encontrado.' },
  idempotency_conflict: {
    status: 409,
    message: 'Esta chave de idempotência já foi usada com outro conteúdo.',
  },
  validation_failed: { status: 422, message: 'Dados inválidos.' },
  missing_actor: { status: 422, message: 'Informe quem pediu a ação (X-Central-Actor).' },
  internal_error: { status: 500, message: 'Erro interno no produto.' },
  capability_unsupported: { status: 501, message: 'Este produto não oferece esta operação.' },
} as const

export type BridgeErrorCode = keyof typeof BRIDGE_ERRORS

export const IDEMPOTENCY_IN_PROGRESS_MESSAGE =
  'Outra requisição com esta chave de idempotência ainda está em andamento.'

export interface BridgeErrorBody {
  error: { code: BridgeErrorCode; message: string }
}

export function errorBody(code: BridgeErrorCode, message?: string): BridgeErrorBody {
  return { error: { code, message: message ?? BRIDGE_ERRORS[code].message } }
}

/**
 * Throw from a handler to answer with a specific contract error.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly status: number

  constructor(code: BridgeErrorCode, message?: string) {
    super(message ?? BRIDGE_ERRORS[code].message)
    this.name = 'BridgeError'
    this.code = code
    this.status = BRIDGE_ERRORS[code].status
  }

  toBody(): BridgeErrorBody {
    return errorBody(this.code, this.message)
  }
}

/**
 * Throw from a handler when the user ref does not exist (→ 404 not_found).
 */
export class UserNotFoundError extends BridgeError {
  constructor(message = 'Usuário não encontrado.') {
    super('not_found', message)
    this.name = 'UserNotFoundError'
  }
}

export class ValidationFailedError extends BridgeError {
  constructor(message?: string) {
    super('validation_failed', message)
    this.name = 'ValidationFailedError'
  }
}
