import 'dotenv/config'
import { env } from '../src/config/env'
import { emailService } from '../src/modules/email/email.service'

async function runSmtpTest() {
  console.log('====================================================')
  console.log('   Hexalyte Gmail SMTP Connection & Verification    ')
  console.log('====================================================')

  console.log('SMTP Host:    ', env.SMTP_HOST || '(not configured)')
  console.log('SMTP Port:    ', env.SMTP_PORT || '(not configured)')
  console.log('SMTP User:    ', env.SMTP_USER || '(not configured)')
  console.log('SMTP Secure:  ', env.SMTP_SECURE ? 'true (SSL/TLS)' : 'false (STARTTLS)')
  console.log('From:         ', env.EMAIL_FROM)
  console.log('Password set: ', env.SMTP_PASS ? `YES (length: ${env.SMTP_PASS.length})` : 'NO')
  console.log('----------------------------------------------------')

  if (!env.SMTP_PASS) {
    console.error('\n❌ ERROR: SMTP_PASS is empty or not set in apps/backend/.env or environment variables.')
    console.error('Please configure your 16-character Gmail App Password in apps/backend/.env:')
    console.error('SMTP_PASS=xxxx xxxx xxxx xxxx')
    console.log('====================================================\n')
    process.exit(1)
  }

  // 1. Verify SMTP Connection & Authentication
  console.log('\n[1/2] Verifying SMTP connection and credentials with smtp.gmail.com:587 (STARTTLS)...')
  const connResult = await emailService.verifyConnection()

  if (!connResult.success) {
    console.error('❌ SMTP Connection/Authentication Failed:', connResult.message)
    console.log('====================================================\n')
    process.exit(1)
  }

  console.log('✅ SMTP Connection & Authentication Succeeded!')
  console.log('   Result:', connResult.message)

  // 2. Dispatch a Real Test Email
  const recipient = process.argv[2] || env.SMTP_USER
  if (!recipient) {
    console.error('\n❌ ERROR: pass a recipient address (npm run test:email -- you@example.com) or set SMTP_USER.')
    process.exit(1)
  }
  console.log(`\n[2/2] Sending test email to ${recipient}...`)

  try {
    const sendResult = await emailService.sendEmail({
      to: recipient,
      subject: 'Hexalyte Innovation - SMTP Verification Test',
      text: `Hello,

This is a live test email sent via Gmail SMTP from Hexalyte Innovation Central Reseller Platform.

Timestamp: ${new Date().toISOString()}
Host: ${env.SMTP_HOST}:${env.SMTP_PORT}
User: ${env.SMTP_USER}

If you received this message, the Gmail SMTP configuration is fully working and emails are being accepted by the server.

Best regards,
Hexalyte Innovation Team`,
      html: `<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; background-color: #f8fafc; padding: 20px;">
  <div style="max-width: 560px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 10px; border: 1px solid #e2e8f0;">
    <h2 style="color: #0284c7; margin-top: 0;">Hexalyte Innovation</h2>
    <p style="font-size: 16px; color: #1e293b;">Gmail SMTP Configuration Test Succeeded!</p>
    <p style="font-size: 14px; color: #475569;">
      This email verifies that <strong>smtp.gmail.com:587</strong> with STARTTLS is successfully connected and authenticating via the configured credentials.
    </p>
    <div style="background: #f1f5f9; padding: 12px; border-radius: 6px; font-size: 13px; font-family: monospace;">
      Host: ${env.SMTP_HOST}:${env.SMTP_PORT}<br>
      Sender: ${env.EMAIL_FROM}<br>
      Timestamp: ${new Date().toISOString()}
    </div>
  </div>
</body>
</html>`,
    })

    console.log('✅ Test email was ACCEPTED by the Gmail SMTP server!')
    console.log('   Message ID:', sendResult.messageId)
    console.log('\n====================================================')
    console.log('   SMTP CONFIGURATION & DISPATCH VERIFIED            ')
    console.log('====================================================\n')
  } catch (err: any) {
    console.error('❌ Failed to dispatch test email:', err.message)
    console.log('====================================================\n')
    process.exit(1)
  }
}

runSmtpTest()
