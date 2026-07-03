FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY AuthService.sln ./
COPY src/AuthService.Api/AuthService.Api.csproj src/AuthService.Api/
COPY src/AuthService.Application/AuthService.Application.csproj src/AuthService.Application/
COPY src/AuthService.Domain/AuthService.Domain.csproj src/AuthService.Domain/
COPY src/AuthService.Infrastructure/AuthService.Infrastructure.csproj src/AuthService.Infrastructure/
RUN dotnet restore src/AuthService.Api/AuthService.Api.csproj

COPY . .
RUN dotnet publish src/AuthService.Api/AuthService.Api.csproj \
  --configuration Release \
  --output /app/publish \
  --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

COPY --from=build /app/publish .

EXPOSE 8080

ENTRYPOINT ["dotnet", "AuthService.Api.dll"]
