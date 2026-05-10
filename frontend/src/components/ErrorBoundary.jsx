import { Component } from 'react'
import { AlertTriangle } from 'lucide-react'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-slate-800/80 border border-red-700/40 rounded-xl p-8 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-600/20 border border-red-600/40 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={18} className="text-red-400" />
              </div>
              <div>
                <h1 className="text-base font-semibold text-slate-100">Error inesperado</h1>
                <p className="text-xs text-slate-500">Algo salió mal al renderizar esta pantalla.</p>
              </div>
            </div>
            <pre className="text-xs text-red-300 bg-slate-900 rounded-lg p-3 overflow-auto max-h-36 leading-relaxed">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload() }}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Recargar aplicación
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
