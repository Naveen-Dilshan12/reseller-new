'use client'

import React from 'react'

export interface PageHeroProps {
  /** Optional category tag (e.g. 'CATALOGUE', 'CLIENT PORTFOLIO', 'TRIAL OPERATIONS') */
  tag?: string
  /** Leading icon for the page */
  icon?: React.ReactNode
  /** Main page title */
  title: string
  /** Subtitle / description */
  subtitle: string
  /** Primary / secondary actions placed on the right */
  actions?: React.ReactNode
  /** Transparent glass KPI grid or child content placed inside the scenic backdrop */
  children?: React.ReactNode
}

export function PageHero({ tag, icon, title, subtitle, actions, children }: PageHeroProps) {
  const hasChildren = Boolean(children)
  return (
    <div className={`compact-hero-backdrop ${hasChildren ? 'has-children' : 'no-kpis'}`}>
      <div className="compact-hero-header">
        <div className="compact-hero-content">
          {tag && (
            <span className="compact-hero-tag">
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: '#F4C76B',
                  boxShadow: '0 0 6px rgba(244, 199, 107, 0.6)',
                }}
                aria-hidden="true"
              />
              {tag}
            </span>
          )}
          <div className="compact-hero-title-row">
            {icon && (
              <div className="page-header-icon" aria-hidden="true">
                {icon}
              </div>
            )}
            <h1 className="compact-hero-title">{title}</h1>
          </div>
          <p className="compact-hero-subtitle">{subtitle}</p>
        </div>

        {actions && <div className="compact-hero-actions">{actions}</div>}
      </div>

      {children && <div className="compact-hero-children">{children}</div>}
    </div>
  )
}
