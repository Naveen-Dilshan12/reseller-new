import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { env } from '../../config/env'
import { logger } from '../../utils/logger'

export interface SendEmailOptions {
  to: string
  subject: string
  html: string
  text: string
}

export interface EmailService {
  sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId?: string }>
  verifyConnection(): Promise<{ success: boolean; message: string }>
}

/**
 * Production-ready email adapter.
 * Uses Nodemailer SMTP when SMTP_HOST is configured; otherwise logs formatted email safely in development / testing.
 */
class HexalyteEmailService implements EmailService {
  private transporter: Transporter | null = null

  private getTransporter(): Transporter | null {
    if (this.transporter) return this.transporter

    // Only configure live SMTP transporter when host, port, and password are provided
    if (env.SMTP_HOST && env.SMTP_PORT && env.SMTP_PASS) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE, // false for 587 (STARTTLS), true for 465
        requireTLS: env.SMTP_PORT === 587,
        auth: env.SMTP_USER
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
            }
          : undefined,
      })
      return this.transporter
    }

    return null
  }

  /**
   * Verifies the SMTP connection and authentication without sending an email.
   */
  async verifyConnection(): Promise<{ success: boolean; message: string }> {
    const transporter = this.getTransporter()
    if (!transporter) {
      return { success: false, message: 'SMTP is not configured (SMTP_HOST/SMTP_PORT missing).' }
    }

    try {
      await transporter.verify()
      logger.info('SMTP connection and authentication verified successfully', {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
      })
      return { success: true, message: `SMTP connection to ${env.SMTP_HOST}:${env.SMTP_PORT} verified successfully.` }
    } catch (err: any) {
      const errorMsg = err?.message || 'SMTP verification failed'
      logger.error('SMTP connection verification failed', err instanceof Error ? err : new Error(errorMsg), {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
      })
      return { success: false, message: errorMsg }
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId?: string }> {
    const transporter = this.getTransporter()

    // If SMTP is configured, send the real email via Nodemailer
    if (transporter) {
      try {
        logger.info('Dispatching email via SMTP', {
          to: options.to,
          subject: options.subject,
          smtpHost: env.SMTP_HOST,
          smtpPort: env.SMTP_PORT,
          smtpUser: env.SMTP_USER,
        })

        const info = await transporter.sendMail({
          from: env.EMAIL_FROM,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
        })

        logger.info('Email accepted by SMTP server', {
          messageId: info.messageId,
          accepted: info.accepted,
          response: info.response,
        })

        return { success: true, messageId: info.messageId }
      } catch (err: any) {
        logger.error('Failed to send email via SMTP', err instanceof Error ? err : new Error(err?.message), {
          to: options.to,
          subject: options.subject,
        })
        throw err
      }
    }

    // Default development/test logger transport
    logger.info('[Email Transport: Logger]', {
      from: env.EMAIL_FROM,
      to: options.to,
      subject: options.subject,
      previewText: options.text.slice(0, 150),
    })

    // Output formatted console box in non-production for developer convenience
    if (env.NODE_ENV !== 'production') {
      console.log('────────────────────────────────────────────────────────────')
      console.log(`✉️  EMAIL DISPATCH: [${options.subject}]`)
      console.log(`To: ${options.to}`)
      console.log(`From: ${env.EMAIL_FROM}`)
      console.log('─'.repeat(60))
      console.log(options.text)
      console.log('────────────────────────────────────────────────────────────')
    }

    return { success: true, messageId: `dev-log-${Date.now()}` }
  }

  /**
   * Generates Hexalyte-branded HTML and plain-text password reset email templates.
   */
  createPasswordResetEmail(recipientName: string, resetUrl: string, expireMinutes: number): { html: string; text: string } {
    const text = `Hello ${recipientName || 'there'},

We received a request to reset your password for your Hexalyte Central Partner Platform account.

To reset your password, please visit the link below:
${resetUrl}

This link is valid for ${expireMinutes} minutes and can only be used once.

If you did not request a password reset, you can safely ignore this email. Your current password will remain unchanged.

Best regards,
Hexalyte Innovation Team
support@hexalyte.com
`

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Hexalyte Password</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 0; }
    .container { max-width: 580px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0; }
    .header { background: #0f172a; padding: 24px; text-align: center; }
    .header h1 { color: #f8fafc; font-size: 20px; margin: 0; font-weight: 700; letter-spacing: -0.02em; }
    .header p { color: #94a3b8; font-size: 13px; margin: 4px 0 0; }
    .content { padding: 32px 28px; line-height: 1.6; }
    .btn-wrap { text-align: center; margin: 30px 0; }
    .btn { display: inline-block; background: #0284c7; color: #ffffff !important; text-decoration: none; font-weight: 600; padding: 13px 28px; border-radius: 8px; font-size: 15px; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3); }
    .url-box { background: #f1f5f9; padding: 12px; border-radius: 6px; word-break: break-all; font-size: 12px; color: #475569; margin-top: 20px; }
    .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Hexalyte Innovation</h1>
      <p>Central Partner Platform</p>
    </div>
    <div class="content">
      <h2 style="font-size: 18px; margin-top: 0; color: #0f172a;">Password Reset Request</h2>
      <p>Hello ${recipientName || 'there'},</p>
      <p>We received a request to reset your password. Click the button below to set a new password:</p>
      <div class="btn-wrap">
        <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
      </div>
      <p style="font-size: 13px; color: #64748b;">
        This link will expire in <strong>${expireMinutes} minutes</strong> and can only be used once. If you did not request this, you can safely ignore this email.
      </p>
      <div class="url-box">
        <strong>Direct link:</strong><br>
        ${resetUrl}
      </div>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Hexalyte Innovation. All rights reserved.<br>
      Colombo, Sri Lanka &bull; support@hexalyte.com
    </div>
  </div>
</body>
</html>`

    return { html, text }
  }

  /**
   * Generates Hexalyte-branded HTML and plain-text 6-digit email OTP templates.
   */
  createEmailVerificationOtpEmail(recipientName: string, otp: string, expireMinutes: number): { html: string; text: string } {
    const text = `Hello ${recipientName || 'there'},

Welcome to Hexalyte Innovation Central Partner Platform!

Your 6-digit verification code is: ${otp}

This code will expire in ${expireMinutes} minutes and can only be used once.

Please enter this code on the email verification screen to activate your account. If you did not request this code, you can safely ignore this email.

Best regards,
Hexalyte Innovation Team
support@hexalyte.com
`

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Verification Code - Hexalyte Innovation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 0; }
    .container { max-width: 580px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0; }
    .header { background: #0f172a; padding: 24px; text-align: center; }
    .header h1 { color: #f8fafc; font-size: 20px; margin: 0; font-weight: 700; letter-spacing: -0.02em; }
    .header p { color: #94a3b8; font-size: 13px; margin: 4px 0 0; }
    .content { padding: 32px 28px; line-height: 1.6; }
    .otp-card { background: #f8fafc; border: 2px dashed #0284c7; border-radius: 10px; padding: 20px; text-align: center; margin: 24px 0; }
    .otp-code { font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0284c7; margin: 0; }
    .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Hexalyte Innovation</h1>
      <p>Central Partner Platform</p>
    </div>
    <div class="content">
      <h2 style="font-size: 18px; margin-top: 0; color: #0f172a;">Verify Your Email Address</h2>
      <p>Hello ${recipientName || 'there'},</p>
      <p>Thank you for signing up with Hexalyte Innovation! Enter the 6-digit verification code below to verify your email address:</p>

      <div class="otp-card">
        <p style="font-size: 13px; color: #64748b; margin: 0 0 8px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em;">Verification Code</p>
        <div class="otp-code">${otp}</div>
        <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 0;">Valid for ${expireMinutes} minutes</p>
      </div>

      <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
        For your security, never share this code with anyone. If you did not create an account with Hexalyte, please ignore this email.
      </p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Hexalyte Innovation. All rights reserved.<br>
      Colombo, Sri Lanka &bull; support@hexalyte.com
    </div>
  </div>
</body>
</html>`

    return { html, text }
  }

  /**
   * Generates Hexalyte-branded HTML and plain-text application received confirmation email.
   */
  createApplicationReceivedEmail(fullName: string, businessName: string, applicationCode: string): { html: string; text: string } {
    const text = `Hello ${fullName},

Thank you for applying to become an authorized partner on the Hexalyte Innovation Central Partner Platform!

Your application reference code is: ${applicationCode}
Business Name: ${businessName}

Your application has been received and is currently under review by our team. Once reviewed and approved, your partner dashboard access will be activated, and you will receive a confirmation email.

If you have any questions or need to submit additional business verification documents, please contact us at support@hexalyte.com.

Best regards,
Hexalyte Innovation Team
Colombo, Sri Lanka
`

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Application Received - Hexalyte Innovation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 0; }
    .container { max-width: 580px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05); border: 1px solid #e2e8f0; }
    .header { background: #0f172a; padding: 24px; text-align: center; }
    .header h1 { color: #f8fafc; font-size: 20px; margin: 0; font-weight: 700; letter-spacing: -0.02em; }
    .header p { color: #94a3b8; font-size: 13px; margin: 4px 0 0; }
    .content { padding: 32px 28px; line-height: 1.6; }
    .ref-badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 6px 14px; border-radius: 6px; font-weight: 700; font-size: 16px; letter-spacing: 0.05em; margin: 10px 0; font-family: monospace; }
    .footer { background: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Hexalyte Innovation</h1>
      <p>Central Partner Platform</p>
    </div>
    <div class="content">
      <h2 style="font-size: 18px; margin-top: 0; color: #0f172a;">Application Received</h2>
      <p>Hello ${fullName},</p>
      <p>Thank you for submitting your partner application for <strong>${businessName}</strong>.</p>
      <p>Your application reference code is:</p>
      <div style="text-align: center;">
        <span class="ref-badge">${applicationCode}</span>
      </div>
      <p>Our verification team is reviewing your personal, business, and payout details. Once approved, you will be able to log in to the Central Partner Platform with your email and password.</p>
      <p style="font-size: 13px; color: #64748b;">
        Need assistance? Contact our partner onboarding team at <a href="mailto:support@hexalyte.com" style="color: #0284c7;">support@hexalyte.com</a>.
      </p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} Hexalyte Innovation. All rights reserved.<br>
      Colombo, Sri Lanka &bull; support@hexalyte.com
    </div>
  </div>
</body>
</html>`

    return { html, text }
  }
}

export const emailService = new HexalyteEmailService()
