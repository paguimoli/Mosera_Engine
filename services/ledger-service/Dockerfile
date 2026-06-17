FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY LedgerService.csproj ./
RUN dotnet restore

COPY . .
RUN dotnet publish LedgerService.csproj \
  --configuration Release \
  --output /app/publish \
  --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

WORKDIR /app

ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

COPY --from=build /app/publish .

EXPOSE 8080

ENTRYPOINT ["dotnet", "LedgerService.dll"]
