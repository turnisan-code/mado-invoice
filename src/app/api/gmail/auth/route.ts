import { NextResponse } from 'next/server'
import { getOAuthClient } from '@/lib/google/client'

export async function GET() {
  const oauth2 = getOAuthClient()
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/drive.file',
    ],
  })
  return NextResponse.redirect(url)
}
