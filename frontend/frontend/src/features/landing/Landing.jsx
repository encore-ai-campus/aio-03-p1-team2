import { useEffect, useRef, useState } from 'react'
import './Landing.css'
import laptopHero from '../../assets/notecam-laptop-hero.png'
import logoHorizontal from '../../assets/logo-horizontal.png'
import ProfileShortcut from '../profile/ProfileShortcut.jsx'

let hasPlayedTitleAnimation = false

export default function Landing({
  onLogin,
  onLogout,
  onHome,
  onProfile,
  isAuthenticated = false,
  profile,
  avatarId,
}) {
  const videoRef = useRef(null)
  const [showVideoControls, setShowVideoControls] = useState(false)
  const [isVideoVisible, setIsVideoVisible] = useState(false)
  const [animateTitle] = useState(() => !hasPlayedTitleAnimation)

  useEffect(() => {
    hasPlayedTitleAnimation = true
  }, [])

  function prepareVideo() {
    const video = videoRef.current
    if (video && !video.getAttribute('src')) video.src = '/notecam-main-hover.mp4'
    return video
  }

  function playVideo() {
    const video = prepareVideo()
    if (video) void video.play().catch(() => {})
  }

  function toggleVideo() {
    const video = prepareVideo()
    if (!video) return
    if (video.paused) playVideo()
    else {
      video.pause()
      setIsVideoVisible(false)
    }
  }

  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <button type="button" className="landing-brand" aria-label="홈으로 이동" onClick={onHome}>
          <img src={logoHorizontal} alt="" width="940" height="220" />
        </button>
        <div className="landing-nav-actions">
          {isAuthenticated && (
            <ProfileShortcut profile={profile} avatarId={avatarId} onClick={onProfile} />
          )}
          <button
            type="button"
            className="landing-login"
            onClick={isAuthenticated ? onLogout : onLogin}
          >
            {isAuthenticated ? '로그아웃' : '로그인'}
          </button>
        </div>
      </nav>

      <section className="landing-hero">
        <div className="landing-copy">
          <span className="landing-eyebrow">HOME, NOTECAM</span>
          <h1 className={animateTitle ? 'landing-title-animate' : undefined}>
            <span className="landing-title-word">집을</span>{' '}
            <span className="landing-title-word">비운</span>{' '}
            <span className="landing-title-word">순간에도</span>
            <br />
            <span className="landing-title-word">
              <em>안심</em>은
            </span>{' '}
            <span className="landing-title-word">켜져</span>{' '}
            <span className="landing-title-word">있어요</span>
          </h1>
          <p>노트캠이 집 안의 움직임을 감지하고, 중요한 순간을 놓치지 않도록 알려드려요.</p>
          <button type="button" className="landing-cta" onClick={onLogin}>
            {isAuthenticated ? '서비스 화면으로 돌아가기' : '내 카메라 확인하기'} <span>→</span>
          </button>
        </div>
        <figure
          className="landing-visual"
          aria-label="노트북 화면에 거실 카메라 영상이 표시된 모습"
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') playVideo()
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') {
              videoRef.current?.pause()
              setIsVideoVisible(false)
            }
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== 'mouse' && !showVideoControls) {
              setShowVideoControls(true)
              playVideo()
            }
          }}
        >
          <video
            ref={videoRef}
            poster={laptopHero}
            preload="none"
            muted
            playsInline
            loop
            controls={showVideoControls}
            tabIndex={0}
            aria-label="NoteCam 서비스 소개 영상. 마우스를 올리거나 화면을 터치하면 재생됩니다."
            onFocus={() => {
              setShowVideoControls(true)
              prepareVideo()
            }}
            onPlaying={() => {
              setIsVideoVisible(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleVideo()
              }
            }}
          />
          <img
            className={`landing-visual-poster${isVideoVisible ? ' is-hidden' : ''}`}
            src={laptopHero}
            alt=""
            aria-hidden="true"
          />
          {!isAuthenticated && (
            <figcaption>로그인 후 내 카메라 화면과 감지 기록을 확인할 수 있어요.</figcaption>
          )}
        </figure>
      </section>

      <section className="landing-features">
        <article>
          <strong>01</strong>
          <h2>놓치지 않는 감지</h2>
          <p>집 안의 움직임을 감지하고 필요한 순간만 알려드려요.</p>
        </article>
        <article>
          <strong>02</strong>
          <h2>한눈에 보는 기록</h2>
          <p>감지된 이벤트와 분석 결과를 편리하게 확인하세요.</p>
        </article>
        <article>
          <strong>03</strong>
          <h2>나만의 안전한 공간</h2>
          <p>로그인한 사용자만 카메라와 기록에 접근할 수 있어요.</p>
        </article>
      </section>
      <footer className="landing-footer">NoteCam · 우리 집을 기록하는 가장 다정한 방법</footer>
    </main>
  )
}
