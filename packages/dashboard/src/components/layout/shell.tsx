'use client'

import * as React from 'react'
import { cn } from '../../lib/utils'
import { Sidebar } from './sidebar'
import { TopBar } from './top-bar'
import { BottomBar } from './bottom-bar'
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '../../components/ui/sheet'
import { Button } from '../../components/ui/button'
import { TooltipProvider } from '../../components/ui/tooltip'
import { Menu } from 'lucide-react'

interface DashboardShellProps {
  children: React.ReactNode
  currentPath?: string
  className?: string
}

export function DashboardShell({ children, currentPath = '/', className }: DashboardShellProps) {
  return (
    <TooltipProvider>
      <div className={cn('flex h-screen bg-af-bg-primary', className)}>
        {/* Desktop sidebar */}
        <div className="hidden md:block">
          <Sidebar currentPath={currentPath} />
        </div>

        {/* Main content area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Mobile header with hamburger */}
          <div className="flex items-center gap-2 border-b border-af-surface-border bg-af-bg-secondary px-3 py-2 md:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-56 p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Sidebar currentPath={currentPath} />
              </SheetContent>
            </Sheet>
            <span className="text-sm font-semibold text-af-text-primary">AgentFactory</span>
          </div>

          <TopBar className="hidden md:flex" />

          <main className="flex-1 overflow-auto">
            {children}
          </main>

          <BottomBar />
        </div>
      </div>
    </TooltipProvider>
  )
}
