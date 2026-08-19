import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Triggers the Google OAuth redirect + callback handling. */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
