Ochild Bot AI + Rolleys
======================

Start:
  npm install
  npm start

Checks:
  npm run check

Railway:
- Railpack uses railpack.json.
- Nixpacks uses nixpacks.toml.
- Both configurations request FFmpeg, fonts, unzip and yt-dlp.
- Keep auth_session/database.json and API keys private; never publish session credentials.

WhatsApp Channel:
1. Set the channel JID ending in @newsletter with: .setch <channel_jid>
2. Reply to an image and run .imgch <caption>.
3. Reply to image/video/sticker and run .stickch.

Feature notes:
- .carousel is a text-card layout, not a native interactive carousel.
- .button and .listmenu send WhatsApp polls, not native buttons/list menus.
- .quiz sends a poll; automatic answer scoring is not implemented.
- .html converts markup to readable WhatsApp text; it does not host a web page.
- .adbanner and .fwdboost metadata spoofing are intentionally unsupported.
- .fakepay, .paymsg and .stickerpay are simulations only, not payment processing.
- .sprem creates an ordinary sticker with a premium-labelled pack; it is not a paid/premium WhatsApp sticker product.
