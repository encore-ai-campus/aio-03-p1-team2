"""원격 Supabase 설정 선택과 로컬 연결 거부를 검증합니다."""

import os
from unittest.mock import patch

import pytest

from backend.config import Settings, load_environment


def remote_settings(**changes):
    return Settings(**{
        'app_env': 'production',
        'auth_provider': 'supabase',
        'supabase_url': 'https://project.example.com',
        'supabase_publishable_key': 'sb_publishable_test',
        'supabase_secret_key': 'sb_secret_test',
        **changes,
    })


def test_dev_profile_overrides_shared_values_but_not_process_environment(tmp_path):
    (tmp_path / '.env').write_text(
        'GEMINI_API_KEY=shared-test-key\nSUPABASE_URL=https://shared.example.com\n'
    )
    (tmp_path / '.env.dev').write_text(
        'SUPABASE_URL=https://project.example.com\nMOTION_DEVICE=cpu\n'
    )
    with patch.dict(os.environ, {'APP_ENV': 'dev', 'MOTION_DEVICE': 'mps'}, clear=True):
        load_environment(tmp_path)
        assert os.environ['SUPABASE_URL'] == 'https://project.example.com'
        assert os.environ['GEMINI_API_KEY'] == 'shared-test-key'
        assert os.environ['MOTION_DEVICE'] == 'mps'


def test_default_uses_shared_env_and_never_loads_local_profile(tmp_path):
    (tmp_path / '.env').write_text('SUPABASE_URL=https://shared.example.com\n')
    (tmp_path / '.env.dev.local').write_text('SUPABASE_URL=http://127.0.0.1:22276\n')
    with patch.dict(os.environ, {}, clear=True):
        load_environment(tmp_path)
        assert os.environ['APP_ENV'] == 'production'
        assert os.environ['SUPABASE_URL'] == 'https://shared.example.com'


@pytest.mark.parametrize('mode', ['local', 'dev-local'])
@pytest.mark.parametrize('source', ['process', 'file'])
def test_removed_profiles_fail_before_loading_connection(tmp_path, mode, source):
    (tmp_path / '.env').write_text(
        f'APP_ENV={mode if source == "file" else "production"}\n'
        'SUPABASE_URL=https://shared.example.com\n'
    )
    env = {'APP_ENV': mode} if source == 'process' else {}
    with patch.dict(os.environ, env, clear=True), pytest.raises(ValueError, match='원격'):
        load_environment(tmp_path)


def test_missing_dev_profile_does_not_silently_use_another_database(tmp_path):
    with patch.dict(os.environ, {'APP_ENV': 'dev'}, clear=True):
        with pytest.raises(ValueError, match='.env.dev'):
            load_environment(tmp_path)


@pytest.mark.parametrize('mode', ['production', 'dev', 'staging', 'test'])
@pytest.mark.parametrize('url', [
    'http://127.0.0.1:22276', 'https://127.0.0.1',
    'https://127.0.0.2', 'https://localhost', 'https://localhost.',
    'https://db.localhost', 'https://db.local',
    'https://[::1]', 'https://[::ffff:127.0.0.1]',
    'https://192.168.0.10', 'https://10.0.0.5', 'https://0.0.0.0',
])
def test_all_profiles_reject_local_supabase(mode, url):
    with pytest.raises(ValueError, match='원격'):
        remote_settings(app_env=mode, supabase_url=url).prepare()


@pytest.mark.parametrize('mode', ['local', 'dev-local'])
def test_settings_cannot_reenable_removed_profile(mode):
    with pytest.raises(ValueError, match='원격'):
        remote_settings(app_env=mode).prepare()


@pytest.mark.parametrize('url', [
    'https://project.supabase.co', 'https://db.example.com',
])
def test_remote_https_is_accepted(url):
    remote_settings(supabase_url=url).prepare()


def test_remote_http_is_rejected():
    with pytest.raises(ValueError, match='HTTPS'):
        remote_settings(supabase_url='http://db.example.com').prepare()


def test_missing_remote_credentials_are_reported():
    with pytest.raises(ValueError, match='필수 설정.*SUPABASE_URL'):
        remote_settings(supabase_url='').prepare()
