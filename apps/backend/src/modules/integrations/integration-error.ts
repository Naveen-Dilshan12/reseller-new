import { AppError } from '../../middleware/error.middleware'

export class IntegrationError extends AppError {
  constructor(
    message: string,
    public httpStatus?: number,
  ) {
    super(message, 502)
    this.name = 'IntegrationError'
  }
}
