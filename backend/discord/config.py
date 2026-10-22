"""기존 공용 Settings를 변경하지 않는 Discord 전용 설정."""

import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class DiscordSettings:
    app_url: str = ""
    auth_enabled: bool = False
    sender_enabled: bool = False
    bot_token: str = field(default="", repr=False)

    @classmethod
    def from_env(cls):
        def flag(name):
            value = os.getenv(name, "false").lower()
            if value not in {"true", "false", "1", "0"}:
                raise ValueError(f"{name}는 true 또는 false여야 합니다.")
            return value in {"true", "1"}

        settings = cls(
            os.getenv("DISCORD_APP_URL", "").rstrip("/"),
            flag("DISCORD_AUTH_ENABLED"), flag("DISCORD_SENDER_ENABLED"),
            os.getenv("DISCORD_BOT_TOKEN", ""),
        )
        settings.validate()
        return settings

    def validate(self):
        if not (self.auth_enabled or self.sender_enabled or self.app_url):
            return
        url = urlsplit(self.app_url)
        local_http = url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
        if (not url.hostname or (url.scheme != "https" and not local_http)
                or url.username or url.password or url.path or url.query or url.fragment):
            raise ValueError("DISCORD_APP_URL에는 HTTPS 앱 origin을 설정하세요. localhost는 HTTP를 허용합니다.")
        if self.sender_enabled and not self.bot_token:
            raise ValueError("Discord 자동 발송에는 DISCORD_BOT_TOKEN이 필요합니다.")

    @property
    def callback_url(self):
        return self.app_url + "/auth/discord/callback"
