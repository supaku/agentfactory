'use client'

import { cn } from '../../lib/utils'
import { Logo } from '../../components/shared/logo'
import { Separator } from '../../components/ui/separator'
import { LayoutDashboard, Columns3, Activity, Settings } from 'lucide-react'

export interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
}

const defaultNavItems: NavItem[] = [
  { label: 'Fleet', href: '/', icon: <LayoutDashboard className="h-4 w-4" /> },
  { label: 'Pipeline', href: '/pipeline', icon: <Columns3 className="h-4 w-4" /> },
  { label: 'Sessions', href: '/sessions', icon: <Activity className="h-4 w-4" /> },
  { label: 'Settings', href: '/settings', icon: <Settings className="h-4 w-4" /> },
]

interface SidebarProps {
  currentPath?: string
  navItems?: NavItem[]
  className?: string
}

export function Sidebar({ currentPath = '/', navItems = defaultNavItems, className }: SidebarProps) {
  const isActive = (href: string) => {
    if (href === '/') return currentPath === '/'
    return currentPath.startsWith(href)
  }

  return (
    <aside
      className={cn(
        'flex h-full w-56 flex-col border-r border-af-surface-border bg-af-bg-secondary',
        className
      )}
    >
      <div className="flex items-center gap-2.5 px-5 py-4">
        <Logo size={24} />
        <span className="text-sm font-semibold text-af-text-primary tracking-tight">
          AgentFactory
        </span>
      </div>

      <Separator />

      <nav className="flex-1 space-y-0.5 px-3 py-3">
        {navItems.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              isActive(item.href)
                ? 'bg-af-surface text-af-text-primary'
                : 'text-af-text-secondary hover:bg-af-surface/50 hover:text-af-text-primary'
            )}
          >
            {item.icon}
            {item.label}
          </a>
        ))}
      </nav>

      <Separator />

      <div className="px-5 py-3">
        <a
          href="https://github.com/supaku/agentfactory"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-af-text-secondary hover:text-af-text-primary transition-colors"
        >
          AgentFactory
        </a>
      </div>
    </aside>
  )
}
