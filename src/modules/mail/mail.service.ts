import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import {
  emailChangedNoticeTemplate,
  orderConfirmationEmailTemplate,
  orderStatusUpdateEmailTemplate,
  otpEmailTemplate,
  passwordChangedEmailTemplate,
  passwordResetEmailTemplate,
  phoneChangedNoticeTemplate,
  welcomeEmailTemplate,
  type OrderConfirmationEmailData,
  type OrderStatusUpdateEmailData,
} from './templates/email.templates';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly fromAddress: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    const port = this.config.get<string>('SMTP_PORT');
    const user = this.config.get<string>('SMTP_USER');
    const password = this.config.get<string>('SMTP_PASSWORD');
    this.fromAddress = this.config.get<string>(
      'SMTP_FROM',
      'Clothing Shop <no-reply@clothing-shop.com>',
    );

    if (host && port && user && password) {
      this.transporter = createTransport({
        host,
        port: Number(port),
        secure: Number(port) === 465,
        auth: { user, pass: password },
      });
    } else {
      this.transporter = null;
      this.logger.warn(
        'Thiếu SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD trong .env — email sẽ chỉ được log ra console thay vì gửi thật.',
      );
    }
  }

  async sendWelcomeEmail(to: string, fullName: string): Promise<void> {
    const { subject, html } = welcomeEmailTemplate(fullName);
    await this.send(to, subject, html);
  }

  async sendOtpEmail(to: string, otp: string): Promise<void> {
    const { subject, html } = otpEmailTemplate(otp);
    await this.send(to, subject, html);
  }

  async sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
    const { subject, html } = passwordResetEmailTemplate(resetLink);
    await this.send(to, subject, html);
  }

  async sendOrderConfirmationEmail(
    to: string,
    order: OrderConfirmationEmailData,
  ): Promise<void> {
    const { subject, html } = orderConfirmationEmailTemplate(order);
    await this.send(to, subject, html);
  }

  async sendOrderStatusUpdateEmail(
    to: string,
    data: OrderStatusUpdateEmailData,
  ): Promise<void> {
    const { subject, html } = orderStatusUpdateEmailTemplate(data);
    await this.send(to, subject, html);
  }

  private async sendBestEffort(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    try {
      await this.send(to, subject, html);
    } catch (err) {
      this.logger.warn(
        `Không gửi được email cảnh báo "${subject}" tới ${to}: ${(err as Error).message}`,
      );
    }
  }

  async sendPasswordChangedEmail(to: string): Promise<void> {
    const { subject, html } = passwordChangedEmailTemplate();
    await this.sendBestEffort(to, subject, html);
  }

  async sendEmailChangedNotice(
    oldEmail: string,
    newEmailMasked: string,
  ): Promise<void> {
    const { subject, html } = emailChangedNoticeTemplate(newEmailMasked);
    await this.sendBestEffort(oldEmail, subject, html);
  }

  async sendPhoneChangedNotice(to: string): Promise<void> {
    const { subject, html } = phoneChangedNoticeTemplate();
    await this.sendBestEffort(to, subject, html);
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[dev] Email to ${to} — "${subject}"\n${html}`);
      return;
    }

    await this.transporter.sendMail({
      from: this.fromAddress,
      to,
      subject,
      html,
    });
  }
}
