import agoraToken from 'agora-token'; // CJS package: named imports fail under Node ESM
import { agoraConfig } from '../config.js';

const { RtcRole, RtcTokenBuilder } = agoraToken;

/** RTC token (publisher role) for one uid on one channel. Used for both the browser user and the agent. */
export function buildRtcToken(channel: string, uid: number, ttlSeconds = 3600): string {
  const { AGORA_APP_ID, AGORA_APP_CERTIFICATE } = agoraConfig();
  return RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_APP_CERTIFICATE,
    channel,
    uid,
    RtcRole.PUBLISHER,
    ttlSeconds,
    ttlSeconds,
  );
}
