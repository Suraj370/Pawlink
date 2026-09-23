import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input, Label } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/api/errors"
import { useLogin } from "../hooks"
import { loginSchema } from "../schemas"

type Props = {
  onSuccess: () => void
}

export function LoginForm({ onSuccess }: Props) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const login = useLogin()

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    const parsed = loginSchema.safeParse({ email, password })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await login.mutateAsync(parsed.data)
      onSuccess()
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Login failed"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <Label>
        Email
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
      </Label>
      <Label>
        Password
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Label>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="login-error">
          {fieldError ?? submitError}
        </p>
      )}
      <Button type="submit" isDisabled={login.isPending} className="mt-2 h-10 w-full">
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
